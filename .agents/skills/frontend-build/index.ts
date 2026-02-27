// Frontend Design Skill
const component = inputs.component || 'landing';
const style = inputs.style || 'minimal';

console.log(\`## Frontend Design: \${component} (\${style})

### Design Principles (Avoid Generic AI Look)

1. **Asymmetry Over Symmetry** - Break grid occasionally
2. **Intentional White Space** - Let elements breathe
3. **Custom Accent Colors** - Not default Tailwind blues
4. **Subtle Animations** - 150-300ms transitions
5. **Typography Hierarchy** - 3-4 sizes max
6. **Real Content** - No lorem ipsum in demos

### Style Guide: \${style}

\${style === 'minimal' ? \`
- Monochrome with single accent
- Thin borders (1px)
- Large padding (p-8, p-12)
- System fonts or Inter
- Subtle shadows (shadow-sm)
\` : style === 'bold' ? \`
- High contrast colors
- Large typography (text-5xl+)
- Thick borders (border-4)
- Geometric shapes
- Strong shadows
\` : style === 'glassmorphism' ? \`
- backdrop-blur-xl
- bg-white/10 backgrounds
- Subtle borders (border-white/20)
- Gradient backgrounds
- Soft shadows
\` : \`
- Clean professional look
- Structured grid layouts
- Brand-consistent colors
- Clear CTAs
\`}

### Component Patterns

\`\`\`tsx
// Avoid: Generic centered hero
<div className="flex flex-col items-center text-center">

// Better: Asymmetric layout with character
<div className="grid grid-cols-1 lg:grid-cols-[1.2fr,1fr] gap-16">
  <div className="space-y-8">
    <h1 className="text-6xl font-bold tracking-tight">
      <span className="text-neutral-900">Build</span>
      <span className="text-orange-500 ml-2">faster.</span>
    </h1>
  </div>
</div>
\`\`\`

### Color Palette Suggestions

Instead of: \`blue-500\`, \`gray-100\`
Try: \`orange-500\`, \`neutral-950\`, \`amber-400\`

### Micro-Interactions

\`\`\`tsx
// Button hover
className="transition-all duration-200 hover:scale-[1.02] hover:shadow-lg"

// Card hover
className="group hover:border-orange-500/50 transition-colors"
\`\`\`
\`);