---
name: algorithmic-art
description: Create generative art with p5.js. Activates for "generative art", "algorithmic art", "p5.js", "creative coding", "procedural", "art generation", "visual algorithm".
allowed-tools: [Read, Write, Bash]
---

# Algorithmic Art Skill

## When This Skill Activates
- "Create generative art", "algorithmic art"
- "p5.js", "creative coding"
- "Procedural generation", "visual algorithm"
- "Make art with code", "generate patterns"
- "Interactive visualization"

## Three-Step Workflow

### Step 1: Algorithmic Philosophy

Before writing code, develop a computational aesthetic manifesto:

**Questions to answer:**
1. What mathematical principles drive the piece?
2. What is the relationship between chaos and order?
3. How does randomness create beauty through constraint?
4. What makes this feel hand-crafted vs mechanical?

**Example manifesto:**
> This piece explores the tension between geometric precision and organic growth. Using seeded Perlin noise, we create forms that feel alive - each seed producing a unique but reproducible composition. The algorithm favors asymmetry within a balanced frame, using the golden ratio to guide placement. Color emerges from HSB rotation, creating harmonious palettes that shift like seasons.

### Step 2: Conceptual Deduction

Identify subtle thematic threads:
- Natural phenomena (growth, decay, flow)
- Mathematical beauty (fractals, spirals, symmetry)
- Temporal elements (cycles, evolution, entropy)
- Emotional qualities (calm, energy, mystery)

### Step 3: p5.js Implementation

**Template structure:**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Generative Art</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script>
    <style>
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #1a1a1a; }
        canvas { border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    </style>
</head>
<body>
<script>
// PARAMETERS - Tune these
const PARAMS = {
    count: 50,
    scale: 0.02,
    speed: 0.01,
    colorShift: 0.3,
};

let seed = 12345;

function setup() {
    createCanvas(800, 800);
    colorMode(HSB, 360, 100, 100, 100);
    noLoop();
    regenerate();
}

function regenerate() {
    randomSeed(seed);
    noiseSeed(seed);
    background(20);
    draw_art();
}

function draw_art() {
    // YOUR ALGORITHM HERE
    for (let i = 0; i < PARAMS.count; i++) {
        let x = random(width);
        let y = random(height);
        let size = noise(x * PARAMS.scale, y * PARAMS.scale) * 100;
        let hue = (noise(x * 0.01, y * 0.01) * 360 + frameCount * PARAMS.colorShift) % 360;

        noStroke();
        fill(hue, 70, 90, 50);
        ellipse(x, y, size, size);
    }
}

function keyPressed() {
    if (key === 'n' || key === 'N') { seed++; regenerate(); }
    if (key === 'p' || key === 'P') { seed--; regenerate(); }
    if (key === 'r' || key === 'R') { seed = floor(random(99999)); regenerate(); }
    if (key === 's' || key === 'S') { saveCanvas('art_' + seed, 'png'); }
}

function mousePressed() {
    seed = floor(random(99999));
    regenerate();
}
</script>
</body>
</html>
```

## Core Techniques

### Noise-Based Forms
```javascript
// Flowing lines with Perlin noise
function flowField() {
    for (let y = 0; y < height; y += 10) {
        beginShape();
        noFill();
        stroke(255, 50);
        for (let x = 0; x < width; x += 5) {
            let angle = noise(x * 0.01, y * 0.01, seed * 0.1) * TWO_PI * 2;
            let yOff = sin(angle) * 20;
            vertex(x, y + yOff);
        }
        endShape();
    }
}
```

### Recursive Patterns
```javascript
// Fractal tree
function branch(len, angle, depth) {
    if (depth <= 0) return;

    stroke(100, 255 - depth * 20, 80);
    strokeWeight(depth * 0.5);

    line(0, 0, 0, -len);
    translate(0, -len);

    push();
    rotate(angle);
    branch(len * 0.7, angle, depth - 1);
    pop();

    push();
    rotate(-angle);
    branch(len * 0.7, angle, depth - 1);
    pop();
}
```

### Particle Systems
```javascript
class Particle {
    constructor(x, y) {
        this.pos = createVector(x, y);
        this.vel = p5.Vector.random2D();
        this.acc = createVector(0, 0);
        this.lifespan = 255;
    }

    update() {
        this.vel.add(this.acc);
        this.pos.add(this.vel);
        this.acc.mult(0);
        this.lifespan -= 2;
    }

    draw() {
        noStroke();
        fill(200, 100, 100, this.lifespan);
        ellipse(this.pos.x, this.pos.y, 8);
    }

    isDead() {
        return this.lifespan <= 0;
    }
}
```

### Voronoi / Cell Patterns
```javascript
// Simple cell pattern
function cellPattern(points) {
    for (let x = 0; x < width; x += 2) {
        for (let y = 0; y < height; y += 2) {
            let minDist = Infinity;
            let closest = 0;

            for (let i = 0; i < points.length; i++) {
                let d = dist(x, y, points[i].x, points[i].y);
                if (d < minDist) {
                    minDist = d;
                    closest = i;
                }
            }

            stroke(closest * 30 % 360, 70, 90);
            point(x, y);
        }
    }
}
```

## Color Strategies

### HSB Rotation
```javascript
colorMode(HSB, 360, 100, 100);
let baseHue = random(360);
let hue1 = baseHue;
let hue2 = (baseHue + 30) % 360;  // Analogous
let hue3 = (baseHue + 180) % 360; // Complementary
```

### Palette from Noise
```javascript
function getColor(x, y) {
    let h = noise(x * 0.01, y * 0.01) * 360;
    let s = 60 + noise(y * 0.02) * 30;
    let b = 70 + noise(x * 0.02, y * 0.02) * 30;
    return color(h, s, b);
}
```

## Controls & Interaction

```javascript
// Seed navigation
function keyPressed() {
    if (key === 'n') seed++;           // Next
    if (key === 'p') seed--;           // Previous
    if (key === 'r') seed = floor(random(99999)); // Random
    if (key === 's') saveCanvas('art_' + seed, 'png'); // Save
    regenerate();
}

// Parameter adjustment
if (keyCode === UP_ARROW) PARAMS.count += 10;
if (keyCode === DOWN_ARROW) PARAMS.count -= 10;
```

## Quality Standards

| Principle | Implementation |
|-----------|----------------|
| **Seeded randomness** | Use `randomSeed()` and `noiseSeed()` |
| **Reproducibility** | Same seed = same output |
| **Parameter control** | Expose tunable values |
| **Export capability** | Save as PNG |
| **Craftsmanship** | Feels hand-refined, not random |

## Anti-Patterns

- **DON'T** use pure random() without seeds
- **DON'T** hardcode magic numbers (use PARAMS object)
- **DON'T** create jarring, unbalanced compositions
- **DON'T** ignore negative space
- **DON'T** use default p5.js colors

## Output Format

```markdown
## Generative Art: [Piece Name]

### Philosophy
[Aesthetic manifesto - what drives this piece]

### Themes
- [Theme 1]
- [Theme 2]

### Technical Approach
- Algorithm: [Flow field, recursion, particles, etc.]
- Color: [HSB rotation, palette, noise-based]
- Interaction: [Keyboard, mouse controls]

### Parameters
| Param | Default | Range | Effect |
|-------|---------|-------|--------|
| count | 50 | 10-200 | Density |

### Controls
- N: Next seed
- P: Previous seed
- R: Random seed
- S: Save PNG

### Output
[HTML file path or embedded code]
```
