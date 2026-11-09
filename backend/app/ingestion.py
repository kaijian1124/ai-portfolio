"""Bounded text extraction. No OCR and no invented DOCX page numbers."""

import re
import unicodedata
from bisect import bisect_left, bisect_right
from functools import lru_cache
from io import BytesIO
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from pypdf import PdfReader
from tiktoken import get_encoding

MAX_TEXT = 900000
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def clean(text):
    return re.sub(r"\n{3,}", "\n\n", unicodedata.normalize("NFC", text).replace("\x00", "")).strip()


def extract_document(data: bytes, suffix: str):
    if len(data) > 20971520:
        raise ValueError("file_too_large")
    result = []
    if suffix == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise ValueError("invalid_pdf")
        try:
            reader = PdfReader(BytesIO(data), strict=True)
            if reader.is_encrypted or len(reader.pages) > 300:
                raise ValueError("encrypted_pdf_or_over_300_pages")
            for index, page in enumerate(reader.pages):
                text = clean(page.extract_text() or "")
                if text:
                    result.append({"text": text, "page": index + 1, "heading": None})
        except ValueError:
            raise
        except Exception:  # noqa: BLE001 - sanitize failures at the external-service/parser boundary
            raise ValueError("pdf_parse_failed") from None
    elif suffix == ".docx":
        try:
            with ZipFile(BytesIO(data)) as archive:
                entries = archive.infolist()
                if (
                    len(entries) > 2000
                    or sum(e.file_size for e in entries) > 31457280
                    or any(e.file_size > max(e.compress_size, 1) * 1000 for e in entries)
                ):
                    raise ValueError("unsafe_document_archive")
                xml = fromstring(archive.read("word/document.xml"))
            heading = None
            paragraphs = []
            for paragraph in xml.iter(W + "p"):
                text = clean("".join(t.text or "" for t in paragraph.iter(W + "t")))
                if not text:
                    continue
                style = paragraph.find(W + "pPr/" + W + "pStyle")
                if style is not None and "heading" in style.attrib.get(W + "val", "").lower():
                    if paragraphs:
                        result.append(
                            {"text": "\n\n".join(paragraphs), "page": None, "heading": heading}
                        )
                    heading = text[:200]
                    paragraphs = [text]
                else:
                    paragraphs.append(text)
            if paragraphs:
                result.append({"text": "\n\n".join(paragraphs), "page": None, "heading": heading})
        except ValueError:
            raise
        except Exception:  # noqa: BLE001 - reject all malformed archives
            raise ValueError("docx_parse_failed") from None
    elif suffix == ".md":
        result = markdown_sections(data)
    else:
        raise ValueError("unsupported_document_type")
    if not result:
        raise ValueError("no_extractable_text_ocr_not_supported")
    if sum(len(s["text"]) for s in result) > MAX_TEXT:
        raise ValueError("document_text_too_large")
    return result


def markdown_sections(data):
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("invalid_markdown_encoding") from None
    if text.startswith(("---\n", "---\r\n")):
        text = re.sub(r"\A---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)", "", text, count=1)
    sections, headings, lines = [], [], []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            value = marker[1]
            if fence is None:
                fence = value
            elif value.startswith(fence) and not line[marker.end() :].strip():
                fence = None
        heading = re.match(r"^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$", line) if fence is None else None
        if heading:
            if body := clean("\n".join(lines)):
                sections.append(
                    {
                        "text": body,
                        "page": None,
                        "heading": " / ".join(t for _, t in headings) or None,
                    }
                )
            level = len(heading[1])
            headings = [(n, title) for n, title in headings if n < level]
            headings.append((level, heading[2]))
            lines = []
        else:
            lines.append(line)
    if body := clean("\n".join(lines)):
        sections.append(
            {"text": body, "page": None, "heading": " / ".join(t for _, t in headings) or None}
        )
    return sections


@lru_cache(maxsize=1)
def tokenizer():
    return get_encoding("cl100k_base")


def embedding_text(chunk):
    return "\n".join(filter(None, (chunk.get("heading"), chunk.get("table_header"), chunk["text"])))


def section_boundaries(text):
    atomic = []
    table_headers = {}
    for block in re.finditer(r"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?(?:^ {0,3}\1[ \t]*$|\Z)", text):
        atomic.append(block.span())
    for table in re.finditer(r"(?m)^(?:[ \t]*\|[^\n]*\n){2,}(?:[ \t]*\|[^\n]*)?", text):
        rows = table[0].splitlines(keepends=True)
        if len(rows) < 2 or not re.fullmatch(r"[|: \t-]+", rows[1].strip()):
            continue
        atomic.append(table.span())
        offset = table.start() + len(rows[0]) + len(rows[1])
        for row in rows[2:]:
            table_headers[offset] = "".join(rows[:2]).strip()[:400]
            offset += len(row)
    matches = re.finditer(r"\n{2,}|(?<=[。！？.!?])(?:[ \t]+|(?=[^\x00-\x7f]))", text)
    boundaries = {
        m.end(): "\n" in m[0]
        for m in matches
        if not any(start < m.end() < end for start, end in atomic)
    }
    boundaries.update(dict.fromkeys(table_headers, True))
    for start, end in atomic:
        boundaries[start] = boundaries[end] = True
    return boundaries, table_headers


def chunk_sections(sections):
    chunks = []
    encode = tokenizer().encode_ordinary
    for section_ordinal, section in enumerate(sections):
        text = clean(section["text"])
        heading = (section.get("heading") or "")[:200] or None
        boundaries, table_headers = section_boundaries(text)
        sentence_ends = sorted(boundaries)
        start = overlap_start = 0
        while start < len(text):
            limit = min(start + 2000, len(text))
            end = limit
            if limit != len(text) or len(encode(text[start:limit])) > 700:
                candidates = sentence_ends[
                    bisect_right(sentence_ends, start) : bisect_right(sentence_ends, limit)
                ]
                fitting = [i for i in candidates if len(encode(text[start:i])) <= 450]
                complete = [
                    i for i in fitting if boundaries[i] and len(encode(text[start:i])) >= 250
                ]
                if complete or fitting:
                    end = (complete or fitting)[-1]
                else:
                    end = min(start + 1600, limit)
                    while len(encode(text[start:end])) > 700:
                        end = start + max(1, (end - start) // 2)
            if end - overlap_start > 2000:
                overlap_start = start
            value = text[overlap_start:end]
            chunk = {
                "ordinal": len(chunks),
                "text": value.strip(),
                "page": section.get("page"),
                "heading": heading,
                "section_ordinal": section_ordinal,
                "source_start": overlap_start + len(value) - len(value.lstrip()),
                "source_end": overlap_start + len(value.rstrip()),
            }
            if start in table_headers:
                chunk["table_header"] = table_headers[start]
            if chunk["text"]:
                if len(encode(embedding_text(chunk))) > 8191:
                    raise ValueError("embedding_input_too_long")
                chunks.append(chunk)
            if len(chunks) > 500:
                raise ValueError("too_many_chunks")
            # Keep one whole bridging sentence when a paragraph is split and it fits.
            index = bisect_left(sentence_ends, end)
            previous = max(start, sentence_ends[index - 1]) if index else start
            overlap_start = (
                previous
                if not boundaries.get(end, True) and len(encode(text[previous:end])) <= 80
                else end
            )
            start = end
    if not chunks:
        raise ValueError("no_chunks")
    return chunks
