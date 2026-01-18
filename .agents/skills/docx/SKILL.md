---
name: docx
description: Create, edit, and analyze Word documents (.docx). Activates for "Word document", "docx", "write document", "create document", "edit document", "tracked changes", "redline".
allowed-tools: [Read, Write, Bash, Task]
---

# Word Document (DOCX) Skill

## When This Skill Activates
- "Create a Word document", "write a docx"
- "Edit this document", "modify the Word file"
- "Add tracked changes", "redline this document"
- "Extract text from docx", "read this Word file"
- "Convert document to markdown"

## Core Workflows

### 1. Reading/Analyzing Documents

**Extract text to markdown:**
```bash
# Using pandoc (preferred)
pandoc input.docx -o output.md

# Using markitdown
python -m markitdown file.docx
```

**Access raw XML for advanced features:**
```bash
# Unzip to access document.xml
unzip -o document.docx -d docx_extracted
cat docx_extracted/word/document.xml | xmllint --format -
```

### 2. Creating New Documents

**Using python-docx:**
```python
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Add title
title = doc.add_heading('Document Title', level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

# Add paragraph with formatting
para = doc.add_paragraph()
run = para.add_run('Bold text')
run.bold = True
para.add_run(' and normal text.')

# Add table
table = doc.add_table(rows=3, cols=3)
table.style = 'Table Grid'
for i, row in enumerate(table.rows):
    for j, cell in enumerate(row.cells):
        cell.text = f'Row {i+1}, Col {j+1}'

# Add image
doc.add_picture('image.png', width=Inches(4))

doc.save('output.docx')
```

### 3. Editing Existing Documents

**Surgical text replacement:**
```python
from docx import Document

doc = Document('input.docx')

for para in doc.paragraphs:
    if 'OLD_TEXT' in para.text:
        for run in para.runs:
            if 'OLD_TEXT' in run.text:
                run.text = run.text.replace('OLD_TEXT', 'NEW_TEXT')

doc.save('output.docx')
```

**Preserve formatting during edits:**
```python
# CRITICAL: Only modify run.text, never recreate runs
# This preserves font, size, color, bold, italic, etc.
for run in para.runs:
    run.text = modified_text  # Keeps all formatting
```

### 4. Tracked Changes (Redlining)

**Workflow for document review:**
1. Convert to markdown for analysis
2. Plan changes systematically
3. Apply in batches (3-10 related changes)
4. Verify all changes applied

**Batch strategy example:**
```python
CHANGES = [
    {"section": "Introduction", "original": "...", "revised": "..."},
    {"section": "Methods", "original": "...", "revised": "..."},
]

for change in CHANGES:
    apply_change(doc, change)
    verify_change(doc, change)
```

## Critical Requirements

| Rule | Description |
|------|-------------|
| **Minimal Edits** | Only mark text that actually changes |
| **Preserve Runs** | Never recreate runs; modify `run.text` only |
| **Batch Changes** | Group 3-10 related changes per batch |
| **Verify After** | Always check changes applied correctly |

## Dependencies

```bash
pip install python-docx markitdown
brew install pandoc  # or apt-get install pandoc
```

## Common Patterns

### Add Header/Footer
```python
section = doc.sections[0]
header = section.header
header.paragraphs[0].text = "Header Text"
```

### Page Break
```python
from docx.enum.text import WD_BREAK
doc.paragraphs[-1].runs[-1].add_break(WD_BREAK.PAGE)
```

### Set Margins
```python
from docx.shared import Inches
section = doc.sections[0]
section.left_margin = Inches(1)
section.right_margin = Inches(1)
```

## Output Format

```markdown
## DOCX Operation: [Create/Edit/Analyze]

### Input
[Source document or requirements]

### Actions Taken
1. [Action 1]
2. [Action 2]

### Output
[Result file path or extracted content]

### Verification
[Confirmation of success]
```
