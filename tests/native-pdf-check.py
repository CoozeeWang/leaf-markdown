"""Run after native-print-check against the PDF fixture, using pdfplumber."""
import sys
import pdfplumber

with pdfplumber.open(sys.argv[1]) as pdf:
    assert len(pdf.pages) >= 2, "Fixture must exercise subsequent pages"
    for index, page in enumerate(pdf.pages, 1):
        assert abs(page.width - 595.276) < 1 and abs(page.height - 841.89) < 1
        chars = page.chars
        assert chars, f"Unexpected blank page {index}"
        margins = (min(c['x0'] for c in chars), page.width - max(c['x1'] for c in chars),
                   min(c['top'] for c in chars), page.height - max(c['bottom'] for c in chars))
        assert min(margins) > 50, f"Page {index} intrudes into 18 mm safety margin: {margins}"
        print(index, tuple(round(value, 2) for value in margins))
    text = '\n'.join(page.extract_text() for page in pdf.pages)
    assert 'FINAL-CONTENT-END' in text and 'R30' in text
    print('Native A4 margins and complete document verified')
