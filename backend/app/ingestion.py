"""Bounded text extraction. No OCR and no invented DOCX page numbers."""

import re
import unicodedata
from bisect import bisect_left, bisect_right
from collections import Counter
from functools import lru_cache
from io import BytesIO
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from pypdf import PdfReader
from tiktoken import get_encoding

MAX_TEXT = 900000
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


MOJIBAKE = re.compile(r"(?:Ã.|Â.|â[\u0080-\u00bf€™œž][\u0080-\u00ff€™œž‘’“”–—])+")
TOC_TITLE = re.compile(r"^(?:table of contents|contents|目录|目錄)$", re.IGNORECASE)
TOC_ENTRY = re.compile(r"(?:\.{2,}|…{2,}|·{3,})\s*\d+\s*$")
WATERMARK = re.compile(
    r"^(?:draft|confidential|sample|do not distribute|机密|草稿)$", re.IGNORECASE
)


def repair_encoding(match):
    value = match.group()
    try:
        return value.encode("cp1252").decode("utf-8")
    except UnicodeError:
        return value


def clean(text):
    text = MOJIBAKE.sub(repair_encoding, text).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(char for char in text if char in "\n\t" or unicodedata.category(char) != "Cc")
    return re.sub(r"\n(?:[ \t]*\n){2,}", "\n\n", unicodedata.normalize("NFC", text)).strip()


def pdf_sections(pages, report=None):
    # The same running title can be extracted before or after the page number.
    lines_by_page = [text.splitlines() for text in pages]
    if report is not None:
        for field in (
            "running_lines_removed",
            "footnote_sections",
            "toc_pages_removed",
            "watermark_lines_removed",
        ):
            report.setdefault(field, 0)
    watermarks = Counter(
        line
        for lines in lines_by_page
        for line in {line.strip().casefold() for line in lines if WATERMARK.fullmatch(line.strip())}
    )
    margins = Counter(
        line
        for lines in lines_by_page
        if len(lines) >= 3
        for line in {line.strip() for line in lines[:2] + lines[-2:]}
        if 10 <= len(line) <= 160 and not re.match(r"^\d+\s{3,}", line)
    )
    repeated = {line for line, count in margins.items() if count >= 3}
    for page, lines in enumerate(lines_by_page, 1):
        # Exclude only a page that consists of a contents heading and entries with page leaders.
        present = [line for line in lines if line.strip()]
        toc = next(
            (i for i, line in enumerate(present[:3]) if TOC_TITLE.fullmatch(line.strip())), None
        )
        if (
            toc is not None
            and len(present[toc + 1 :]) >= 3
            and all(TOC_ENTRY.search(line) for line in present[toc + 1 :])
        ):
            if report is not None:
                report["toc_pages_removed"] += 1
            continue
        watermark_lines = {
            i
            for i, line in enumerate(lines)
            if WATERMARK.fullmatch(line.strip()) and watermarks[line.strip().casefold()] >= 3
        }
        remove = set(watermark_lines)
        for i in sorted({0, 1, len(lines) - 2, len(lines) - 1} & set(range(len(lines)))):
            if len(lines) >= 3 and lines[i].strip() in repeated:
                remove.add(i)
                for adjacent in (i - 1, i + 1):
                    if 0 <= adjacent < len(lines) and re.fullmatch(
                        r"(?:page\s+)?\d{1,4}", lines[adjacent].strip(), re.IGNORECASE
                    ):
                        remove.add(adjacent)
        if len(remove) == len(lines):
            remove.clear()
        if report is not None:
            report["running_lines_removed"] += len(remove - watermark_lines)
            report["watermark_lines_removed"] += len(remove & watermark_lines)
        text = clean("\n".join(line for i, line in enumerate(lines) if i not in remove))
        # Keep identifiable references searchable, but separate trailing notes from the body.
        footnote = re.search(r"(?m)^\d{1,3}[ \t]{4,}\S", text)
        if report is not None and footnote:
            report["footnote_sections"] += 1
        parts = (text[: footnote.start()], text[footnote.start() :]) if footnote else (text,)
        for part in parts:
            if part.strip():
                yield {"text": part.strip(), "page": page, "heading": None}


def pdf_layout_tables(text, layout):
    """Use aligned PDF columns only when the same text can be found in plain extraction."""
    if len(layout) > MAX_TEXT:
        return text, 0
    count = 0
    rows = []
    lead = []
    separator = re.compile(r" {3,}")
    wordspace = re.compile(r"\s+")

    def replace_rows():
        nonlocal text, count
        # Numeric note labels in a PDF margin are usually citations, not table cells.
        if len(rows) < 3 or all(row[0].isdigit() for row in rows):
            return
        source = r"\s+".join(
            r"\s+".join(re.escape(word) for word in cell.split()) for row in rows for cell in row
        )
        matches = list(re.finditer(source, text))
        if len(matches) == 1:
            columns = len(rows[0])
            header = "| " + " | ".join(f"Column {i + 1}" for i in range(columns)) + " |"
            markdown = [header, "| " + " | ".join(["---"] * columns) + " |"]
            markdown += [
                "| " + " | ".join(c.replace("|", "&#124;") for c in row) + " |" for row in rows
            ]
            match = matches[0]
            text = (
                text[: match.start()] + "\n\n" + "\n".join(markdown) + "\n\n" + text[match.end() :]
            )
            count += 1

    for line in [*layout.splitlines(), ""]:
        line = line.strip()
        gaps = list(separator.finditer(line))
        positions = [m.end() for m in gaps]
        cells = [part.strip() for part in separator.split(line)]
        valid = (
            2 <= len(cells) <= 10
            and all(0 < len(cell) <= 80 and len(wordspace.findall(cell)) <= 10 for cell in cells)
            and not line.startswith("|")
            and not TOC_ENTRY.search(line)
        )
        if (
            not valid
            or len(positions) != len(lead)
            or any(abs(x - y) > 2 for x, y in zip(positions, lead))
        ):
            replace_rows()
            rows, lead = [], []
        if valid:
            if not rows:
                lead = positions
            rows.append(cells)
    return text, count


def docx_text(node):
    if node.tag in {W + "del", W + "moveFrom", W + "commentReference", W + "pict", W + "drawing"}:
        return ""
    if node.tag == W + "t":
        return node.text or ""
    if node.tag in {W + "tab", W + "br"}:
        return " "
    return "".join(docx_text(child) for child in node)


def docx_table(table):
    rows = []
    header_marked = False
    for row in table.findall(W + "tr"):
        cells = []
        for cell in row.findall(W + "tc"):
            nested = cell.findall(W + "tbl")
            value = "<br>".join(filter(None, (clean(docx_text(p)) for p in cell.findall(W + "p"))))
            if nested:
                nested_rows = [clean(docx_text(p)) for table in nested for p in table.iter(W + "p")]
                value = " · ".join(filter(None, (value, " · ".join(filter(None, nested_rows)))))
            span = cell.find(W + "tcPr/" + W + "gridSpan")
            merge = cell.find(W + "tcPr/" + W + "vMerge")
            width = min(32, max(1, int(span.get(W + "val", "1")))) if span is not None else 1
            if merge is not None and merge.get(W + "val") != "restart" and not value:
                value = "[merged above]"
            cells.extend([value.replace("|", "&#124;")] + ["[merged left]"] * (width - 1))
        if cells:
            if not rows:
                header_marked = row.find(W + "trPr/" + W + "tblHeader") is not None
            rows.append(cells)
    if not rows:
        return ""
    width = max(map(len, rows))
    header = rows.pop(0) if header_marked else [f"Column {i + 1}" for i in range(width)]

    def line(cells):
        return "| " + " | ".join(cells + [""] * (width - len(cells))) + " |"

    return "\n".join([line(header), line(["---"] * width), *(line(cells) for cells in rows)])


def docx_sections(xml, report):
    heading = None
    paragraphs = []
    result = []
    tables = contents = 0
    body = xml.find(W + "body")
    if body is None:
        return result
    blocks = iter(body)
    deferred = []
    while True:
        block = next(blocks, None)
        if block is None:
            if not deferred:
                break
            blocks = deferred.pop()
            continue
        if block.tag == W + "sdt":
            properties = block.find(W + "sdtPr")
            gallery = (
                properties.find(".//" + W + "docPartGallery") if properties is not None else None
            )
            if gallery is not None and "table of contents" in gallery.get(W + "val", "").lower():
                contents += 1
                continue
            nested = block.find(W + "sdtContent")
            if nested is not None:
                deferred.append(blocks)
                blocks = iter(nested)
        if block.tag == W + "tbl":
            if table := docx_table(block):
                paragraphs.append(table)
                tables += 1
            continue
        if block.tag != W + "p":
            continue
        style = block.find(W + "pPr/" + W + "pStyle")
        name = style.get(W + "val", "").lower() if style is not None else ""
        if re.fullmatch(r"toc\s*\d+|tocheading", name):
            contents += 1
            continue
        if not (text := clean(docx_text(block))):
            continue
        if "heading" in name:
            if paragraphs:
                result.append({"text": "\n\n".join(paragraphs), "page": None, "heading": heading})
            heading, paragraphs = text[:200], []
        paragraphs.append(text)
    if paragraphs:
        result.append({"text": "\n\n".join(paragraphs), "page": None, "heading": heading})
    if report is not None:
        report.update(docx_tables=tables, docx_contents_blocks_removed=contents)
    return result


def extract_document(data: bytes, suffix: str, report=None):
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
            pages = []
            total_text = 0
            annotations = 0
            tables = 0
            for page in reader.pages:
                # Annotation bodies are not part of the extracted page text.
                annotation_refs = page.get("/Annots") if hasattr(page, "get") else None
                if annotation_refs is not None:
                    annotations += len(
                        annotation_refs.get_object()
                        if hasattr(annotation_refs, "get_object")
                        else annotation_refs
                    )
                text = clean(page.extract_text() or "")
                # Keep plain text if layout extraction cannot reconstruct a table confidently.
                if hasattr(page, "get") and text:
                    try:
                        layout = page.extract_text(extraction_mode="layout") or ""
                        text, restored = pdf_layout_tables(text, layout)
                        tables += restored
                    except TypeError, ValueError, KeyError:
                        pass
                total_text += len(text)
                if total_text > MAX_TEXT:
                    raise ValueError("document_text_too_large")
                pages.append(text)
            if report is not None:
                report.update(
                    pdf_pages=len(pages),
                    pdf_annotations_skipped=annotations,
                    pdf_tables_reconstructed=tables,
                )
            result.extend(pdf_sections(pages, report))
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
            result = docx_sections(xml, report)
        except ValueError:
            raise
        except Exception:  # noqa: BLE001 - reject all malformed archives
            raise ValueError("docx_parse_failed") from None
    elif suffix == ".md":
        result = markdown_sections(data)
    else:
        raise ValueError("unsupported_document_type")
    if report is not None:
        report["unresolved_glyphs"] = sum(s["text"].count("\ufffd") for s in result)
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
        and not (
            m.group().strip() == ""
            and "\n" not in m.group()
            and re.search(r"(?:\b[A-Z]\.){2,}$", text[max(0, m.start() - 16) : m.start()])
            and text[m.end() : m.end() + 1].islower()
        )
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
