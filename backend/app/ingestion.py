"""Bounded text extraction. No OCR and no invented DOCX page numbers."""

import re
import unicodedata
from io import BytesIO
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from pypdf import PdfReader

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
            if reader.is_encrypted or len(reader.pages) > 100:
                raise ValueError("encrypted_or_too_many_pages")
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
    else:
        raise ValueError("unsupported_document_type")
    if not result:
        raise ValueError("no_extractable_text_ocr_not_supported")
    if sum(len(s["text"]) for s in result) > MAX_TEXT:
        raise ValueError("document_text_too_large")
    return result


def chunk_sections(sections):
    chunks = []
    for section in sections:
        text = clean(section["text"])
        for start in range(0, len(text), 1600):
            value = text[start : start + 1800].strip()
            if value:
                chunks.append(
                    {
                        "ordinal": len(chunks),
                        "text": value,
                        "page": section.get("page"),
                        "heading": section.get("heading"),
                    }
                )
            if start + 1800 >= len(text):
                break
    if not chunks:
        raise ValueError("no_chunks")
    if len(chunks) > 500:
        raise ValueError("too_many_chunks")
    return chunks
