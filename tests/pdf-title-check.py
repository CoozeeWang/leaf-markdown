"""Check metadata produced by the actual PDF renderer, not just document.title."""
import sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
assert reader.metadata.title == sys.argv[2], repr(reader.metadata.title)
assert len(reader.pages) >= 2, "Must cover pagination"
text = "\n".join(page.extract_text() for page in reader.pages)
assert "FINAL-CONTENT-END" in text, "Final page must survive export"
assert "Microsoft: Print To PDF" != reader.metadata.producer
for page in reader.pages:
    assert abs(float(page.mediabox.width) - 595.276) < 1
    assert abs(float(page.mediabox.height) - 841.89) < 1
print("PASS: Unicode PDF title, A4 pages and final content")
