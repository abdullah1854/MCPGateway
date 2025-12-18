# Contributing to MCP Gateway

Thank you for your interest in contributing to MCP Gateway! We welcome contributions from the community.

## How to Contribute

### Reporting Issues

- Search existing issues before creating a new one
- Use the issue templates when available
- Provide detailed information including:
  - Steps to reproduce
  - Expected vs actual behavior
  - Environment details (OS, Node version, etc.)
  - Relevant logs or error messages

### Suggesting Features

- Check if the feature has already been requested
- Clearly describe the feature and its use case
- Explain how it would benefit the project

### Code Contributions

1. **Fork the repository** and create your branch from `main`
2. **Install dependencies**: `npm install`
3. **Make your changes**
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation as needed
4. **Test your changes**: `npm test` and `npm run typecheck`
5. **Commit your changes** with clear, descriptive commit messages
6. **Push to your fork** and submit a pull request

### Pull Request Guidelines

- Keep PRs focused on a single feature or fix
- Link related issues in the PR description
- Ensure all tests pass
- Update the README if you change functionality
- Be responsive to feedback and requested changes

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/MCPGateway.git
cd MCPGateway

# Install dependencies
npm install

# Run in development mode
npm run dev

# Run type checking
npm run typecheck

# Run linting
npm run lint
```

### Code Style

- Use TypeScript
- Follow ESLint configuration
- Use meaningful variable and function names
- Comment complex logic
- Keep functions focused and concise

### Testing

- Write tests for new features
- Ensure existing tests pass
- Test edge cases
- Include integration tests when appropriate

### Documentation

- Update README.md for new features
- Add inline comments for complex code
- Update API documentation
- Include examples where helpful

## Community

- Be respectful and inclusive
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md)
- Help others when you can
- Share knowledge and learn together

## Questions?

If you have questions, feel free to:
- Open an issue for discussion
- Check existing documentation
- Review closed issues and PRs

Thank you for contributing to MCP Gateway!
