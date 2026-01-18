---
name: pptx
description: Create, edit, and analyze PowerPoint presentations (.pptx). Activates for "PowerPoint", "pptx", "presentation", "slides", "deck", "create slides".
allowed-tools: [Read, Write, Bash, Task]
---

# PowerPoint (PPTX) Skill

## When This Skill Activates
- "Create a presentation", "make slides"
- "PowerPoint", "pptx", "deck"
- "Add slide", "edit presentation"
- "Convert presentation to PDF"
- "Extract slides", "presentation template"

## Core Workflows

### 1. Reading/Analyzing Presentations

**Extract to markdown:**
```bash
python -m markitdown presentation.pptx
```

**Access raw XML:**
```bash
unzip -o presentation.pptx -d pptx_extracted
ls pptx_extracted/ppt/slides/  # Individual slide XML
```

### 2. Creating Presentations

**Using python-pptx:**
```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RgbColor

prs = Presentation()

# Add title slide
title_layout = prs.slide_layouts[0]
slide = prs.slides.add_slide(title_layout)
title = slide.shapes.title
subtitle = slide.placeholders[1]

title.text = "Presentation Title"
subtitle.text = "Subtitle Here"

# Add content slide
content_layout = prs.slide_layouts[1]
slide = prs.slides.add_slide(content_layout)
slide.shapes.title.text = "Slide Title"

# Add bullet points
body = slide.placeholders[1]
tf = body.text_frame
tf.text = "First bullet point"

p = tf.add_paragraph()
p.text = "Second bullet point"
p.level = 0

p = tf.add_paragraph()
p.text = "Sub-bullet"
p.level = 1

prs.save('output.pptx')
```

### 3. Adding Visual Elements

**Images:**
```python
from pptx.util import Inches

slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank slide
slide.shapes.add_picture(
    'image.png',
    left=Inches(1),
    top=Inches(1),
    width=Inches(4)
)
```

**Tables:**
```python
from pptx.util import Inches

rows, cols = 3, 4
left, top = Inches(1), Inches(2)
width, height = Inches(8), Inches(2)

table = slide.shapes.add_table(rows, cols, left, top, width, height).table

# Set column headers
table.cell(0, 0).text = 'Header 1'
table.cell(0, 1).text = 'Header 2'

# Fill data
for row in range(1, rows):
    for col in range(cols):
        table.cell(row, col).text = f'R{row}C{col}'
```

**Charts:**
```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

chart_data = CategoryChartData()
chart_data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
chart_data.add_series('Sales', (19.2, 21.4, 16.7, 28.0))

x, y, cx, cy = Inches(2), Inches(2), Inches(6), Inches(4)
slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, cx, cy, chart_data
)
```

### 4. Styling

**Text formatting:**
```python
from pptx.util import Pt
from pptx.dml.color import RgbColor

paragraph = shape.text_frame.paragraphs[0]
run = paragraph.runs[0]

run.font.name = 'Arial'
run.font.size = Pt(24)
run.font.bold = True
run.font.color.rgb = RgbColor(0x14, 0x14, 0x13)  # Dark
```

**Slide background:**
```python
from pptx.dml.color import RgbColor
from pptx.enum.dml import MSO_THEME_COLOR

background = slide.background
fill = background.fill
fill.solid()
fill.fore_color.rgb = RgbColor(0xFA, 0xF9, 0xF5)  # Light cream
```

### 5. Design Palettes

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Professional** | #141413 | #FAF9F5 | #D97757 |
| **Ocean** | #1E3A5F | #EAF4FC | #4A90D9 |
| **Forest** | #2D4739 | #F5F9F6 | #6B8E23 |
| **Minimal** | #333333 | #FFFFFF | #FF6B35 |

### 6. Converting to PDF/Images

**To PDF:**
```bash
# Using LibreOffice
libreoffice --headless --convert-to pdf presentation.pptx

# Using unoconv
unoconv -f pdf presentation.pptx
```

**To images:**
```bash
# Using pdftoppm (convert to PDF first, then images)
libreoffice --headless --convert-to pdf presentation.pptx
pdftoppm presentation.pdf slide -png
```

### 7. Template-Based Creation

```python
from pptx import Presentation

# Load template
prs = Presentation('template.pptx')

# Get available layouts
for i, layout in enumerate(prs.slide_layouts):
    print(f'{i}: {layout.name}')

# Use specific layout
slide = prs.slides.add_slide(prs.slide_layouts[2])

# Replace placeholder text
for shape in slide.placeholders:
    if shape.has_text_frame:
        if 'Title' in shape.text:
            shape.text = 'New Title'
```

## Dependencies

```bash
pip install python-pptx markitdown
brew install libreoffice poppler  # For PDF conversion
```

## Slide Layout Reference

| Index | Layout Name | Use For |
|-------|-------------|---------|
| 0 | Title Slide | Opening slide |
| 1 | Title and Content | Standard content |
| 2 | Section Header | Section breaks |
| 3 | Two Content | Comparison |
| 4 | Comparison | Side-by-side |
| 5 | Title Only | Custom content |
| 6 | Blank | Full custom |

## Output Format

```markdown
## PPTX Operation: [Create/Edit/Analyze]

### Input
[Template or requirements]

### Slides Created
1. Slide 1: [Title/Content summary]
2. Slide 2: [Title/Content summary]

### Styling Applied
- Theme: [Name]
- Fonts: [Primary, Secondary]
- Colors: [Palette]

### Output
[File path, slide count]
```
