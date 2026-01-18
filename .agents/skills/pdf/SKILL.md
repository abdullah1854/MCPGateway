---
name: pdf
description: Create, merge, split, and extract content from PDF files. Activates for "PDF", "merge PDF", "split PDF", "extract text", "create PDF", "PDF form".
allowed-tools: [Read, Write, Bash, Task]
---

# PDF Processing Skill

## When This Skill Activates
- "Create a PDF", "generate PDF"
- "Merge PDFs", "combine PDF files"
- "Split PDF", "extract pages"
- "Extract text from PDF"
- "Fill PDF form"
- "Add watermark", "protect PDF"

## Core Libraries

| Library | Best For |
|---------|----------|
| **pypdf** | Merge, split, rotate, metadata |
| **pdfplumber** | Text/table extraction with layout |
| **reportlab** | Creating PDFs from scratch |
| **PyMuPDF (fitz)** | Advanced manipulation, images |

## Workflows

### 1. Extract Text

**With layout preservation:**
```bash
# CLI tool (best for layout)
pdftotext -layout input.pdf output.txt
```

**Using pdfplumber (Python):**
```python
import pdfplumber

with pdfplumber.open('input.pdf') as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

### 2. Extract Tables

```python
import pdfplumber
import pandas as pd

with pdfplumber.open('input.pdf') as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            df = pd.DataFrame(table[1:], columns=table[0])
            print(df)
```

### 3. Merge PDFs

```python
from pypdf import PdfMerger

merger = PdfMerger()
merger.append('file1.pdf')
merger.append('file2.pdf')
merger.append('file3.pdf')
merger.write('merged.pdf')
merger.close()
```

**CLI alternative:**
```bash
qpdf --empty --pages file1.pdf file2.pdf file3.pdf -- merged.pdf
```

### 4. Split PDF

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader('input.pdf')

# Split each page into separate file
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f'page_{i+1}.pdf')

# Extract specific pages (1-5)
writer = PdfWriter()
for i in range(5):
    writer.add_page(reader.pages[i])
writer.write('pages_1-5.pdf')
```

### 5. Create PDF from Scratch

**Simple text document:**
```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

c = canvas.Canvas('output.pdf', pagesize=letter)
c.setFont('Helvetica', 12)
c.drawString(72, 750, 'Hello, World!')
c.save()
```

**Structured document with Platypus:**
```python
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.pagesizes import letter

doc = SimpleDocTemplate('output.pdf', pagesize=letter)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph('Title', styles['Heading1']))
story.append(Spacer(1, 12))
story.append(Paragraph('Body text here...', styles['Normal']))

doc.build(story)
```

### 6. Rotate Pages

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader('input.pdf')
writer = PdfWriter()

for page in reader.pages:
    page.rotate(90)  # 90, 180, 270
    writer.add_page(page)

writer.write('rotated.pdf')
```

### 7. Add Watermark

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader('watermark.pdf').pages[0]
reader = PdfReader('input.pdf')
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

writer.write('watermarked.pdf')
```

### 8. Password Protection

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader('input.pdf')
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

writer.encrypt('user_password', 'owner_password')
writer.write('protected.pdf')
```

### 9. OCR for Scanned PDFs

```python
import pytesseract
from pdf2image import convert_from_path

# Convert PDF pages to images
images = convert_from_path('scanned.pdf')

# OCR each page
for i, image in enumerate(images):
    text = pytesseract.image_to_string(image)
    print(f'--- Page {i+1} ---')
    print(text)
```

## CLI Tools Reference

```bash
# Extract text with layout
pdftotext -layout input.pdf output.txt

# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- output.pdf

# Split PDF (extract pages 1-5)
qpdf input.pdf --pages . 1-5 -- output.pdf

# Rotate 90 degrees
qpdf input.pdf --rotate=90 -- output.pdf

# Decrypt PDF
qpdf --decrypt input.pdf output.pdf
```

## Dependencies

```bash
pip install pypdf pdfplumber reportlab PyMuPDF pytesseract pdf2image
brew install poppler tesseract qpdf  # macOS
# apt-get install poppler-utils tesseract-ocr qpdf  # Linux
```

## Form Filling (Advanced)

For PDF forms, use PyMuPDF:
```python
import fitz

doc = fitz.open('form.pdf')
page = doc[0]

# Get form fields
for widget in page.widgets():
    print(widget.field_name, widget.field_value)

# Fill field
for widget in page.widgets():
    if widget.field_name == 'name':
        widget.field_value = 'John Doe'
        widget.update()

doc.save('filled.pdf')
```

## Output Format

```markdown
## PDF Operation: [Extract/Merge/Split/Create]

### Input
[Source files or content]

### Actions
1. [Action taken]
2. [Action taken]

### Output
[Result file: path, pages, size]

### Verification
[Success confirmation]
```
