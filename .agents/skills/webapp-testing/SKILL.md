---
name: webapp-testing
description: Test web applications with Playwright automation. Activates for "test webapp", "Playwright", "browser automation", "E2E testing", "end-to-end", "UI testing", "screenshot".
allowed-tools: [Read, Write, Bash, Task]
---

# Web Application Testing Skill

## When This Skill Activates
- "Test this web app", "E2E testing"
- "Playwright", "browser automation"
- "Take screenshot", "verify UI"
- "Test the frontend", "check if this works"
- "Automate browser", "UI testing"

## Core Capabilities

| Feature | Description |
|---------|-------------|
| Navigation | Go to URLs, click, fill forms |
| Verification | Assert text, elements, states |
| Screenshots | Capture page or element |
| Console logs | Capture browser console |
| Network | Monitor requests/responses |

## Setup

```bash
# Install Playwright
pip install playwright
playwright install  # Downloads browsers

# Or with npm
npm init playwright@latest
```

## Basic Workflow

### 1. Launch Browser & Navigate
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)  # headless=True for CI
    page = browser.new_page()

    # Navigate
    page.goto("https://example.com")

    # Wait for page load
    page.wait_for_load_state("networkidle")

    # Your tests here...

    browser.close()
```

### 2. Find Elements

```python
# By text content
button = page.get_by_text("Submit")
link = page.get_by_role("link", name="Sign In")

# By test ID (best practice)
element = page.get_by_test_id("login-button")

# By CSS selector
input_field = page.locator("input[name='email']")

# By placeholder
email = page.get_by_placeholder("Enter your email")

# By label
password = page.get_by_label("Password")
```

### 3. Interact with Page

```python
# Click
page.get_by_text("Submit").click()

# Fill form
page.get_by_label("Email").fill("user@example.com")
page.get_by_label("Password").fill("password123")

# Select dropdown
page.get_by_label("Country").select_option("US")

# Check checkbox
page.get_by_label("Remember me").check()

# Press keys
page.keyboard.press("Enter")
page.keyboard.type("Hello World")
```

### 4. Assertions

```python
from playwright.sync_api import expect

# Text visible
expect(page.get_by_text("Welcome")).to_be_visible()

# Element has text
expect(page.locator("h1")).to_have_text("Dashboard")

# Element count
expect(page.locator(".item")).to_have_count(5)

# URL contains
expect(page).to_have_url_containing("/dashboard")

# Input has value
expect(page.get_by_label("Email")).to_have_value("user@example.com")
```

### 5. Screenshots

```python
# Full page
page.screenshot(path="screenshot.png", full_page=True)

# Specific element
page.locator(".modal").screenshot(path="modal.png")

# With comparison (visual regression)
expect(page).to_have_screenshot("baseline.png")
```

### 6. Console & Network

```python
# Capture console logs
page.on("console", lambda msg: print(f"Console: {msg.text}"))

# Capture network requests
def log_request(request):
    print(f"Request: {request.method} {request.url}")
page.on("request", log_request)

# Wait for specific request
with page.expect_response("**/api/users") as response_info:
    page.get_by_text("Load Users").click()
response = response_info.value
print(response.json())
```

## Test Patterns

### Login Flow Test
```python
def test_login():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Navigate to login
        page.goto("https://app.example.com/login")

        # Fill credentials
        page.get_by_label("Email").fill("test@example.com")
        page.get_by_label("Password").fill("password123")

        # Submit
        page.get_by_role("button", name="Sign In").click()

        # Verify redirect to dashboard
        page.wait_for_url("**/dashboard")
        expect(page.get_by_text("Welcome")).to_be_visible()

        browser.close()
```

### Form Validation Test
```python
def test_form_validation():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("https://app.example.com/signup")

        # Submit empty form
        page.get_by_role("button", name="Submit").click()

        # Check validation errors
        expect(page.get_by_text("Email is required")).to_be_visible()
        expect(page.get_by_text("Password is required")).to_be_visible()

        # Fill invalid email
        page.get_by_label("Email").fill("invalid-email")
        page.get_by_role("button", name="Submit").click()

        expect(page.get_by_text("Invalid email format")).to_be_visible()

        browser.close()
```

### API Response Test
```python
def test_api_integration():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("https://app.example.com")

        # Intercept API response
        with page.expect_response("**/api/products") as response_info:
            page.get_by_text("Load Products").click()

        response = response_info.value
        assert response.status == 200

        products = response.json()
        assert len(products) > 0

        # Verify UI reflects data
        expect(page.locator(".product-card")).to_have_count(len(products))

        browser.close()
```

## Running Tests

```bash
# Run all tests
pytest tests/ -v

# Run with visible browser
pytest tests/ -v --headed

# Run specific test
pytest tests/test_login.py::test_login -v

# Generate HTML report
pytest tests/ -v --html=report.html

# Parallel execution
pytest tests/ -v -n auto
```

## CI/CD Integration

**GitHub Actions:**
```yaml
name: E2E Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install playwright pytest
      - run: playwright install --with-deps
      - run: pytest tests/ -v
```

## Debugging Tips

```python
# Pause execution for debugging
page.pause()  # Opens Playwright Inspector

# Slow down actions
browser = p.chromium.launch(slow_mo=500)  # 500ms delay

# Trace for debugging
context = browser.new_context()
context.tracing.start(screenshots=True, snapshots=True)
# ... run test ...
context.tracing.stop(path="trace.zip")
# View: playwright show-trace trace.zip
```

## Output Format

```markdown
## Webapp Test: [Test Name]

### Target
[URL or app being tested]

### Test Cases
1. [ ] [Test case 1]: [Expected result]
2. [ ] [Test case 2]: [Expected result]

### Results
| Test | Status | Notes |
|------|--------|-------|
| Login flow | PASS | 2.3s |
| Form validation | PASS | 1.8s |
| API integration | FAIL | 404 on /api/products |

### Screenshots
[Paths to captured screenshots]

### Issues Found
- [Issue 1]: [Description]
- [Issue 2]: [Description]
```
