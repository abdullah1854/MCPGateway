# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of MCP Gateway seriously. If you discover a security vulnerability, please follow these steps:

### Where to Report

**Please do NOT create a public GitHub issue for security vulnerabilities.**

Instead, report security issues via one of these methods:

1. **GitHub Security Advisories** (Recommended)
   - Go to the Security tab of this repository
   - Click "Report a vulnerability"
   - Fill in the vulnerability details

2. **Email**
   - Send details to the repository maintainer
   - Create a private issue if you have collaborator access

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact and attack scenarios
- Suggested fix (if you have one)
- Your contact information for follow-up

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next regular release

### What to Expect

1. We will acknowledge receipt of your vulnerability report
2. We will investigate and confirm the vulnerability
3. We will develop and test a fix
4. We will release a security update
5. We will publicly disclose the vulnerability after the patch is released
6. We will credit you for the discovery (unless you prefer to remain anonymous)

## Security Best Practices

When using MCP Gateway:

### Authentication

- Always use authentication in production (`AUTH_MODE=api-key` or `AUTH_MODE=oauth`)
- Never use `AUTH_MODE=none` in production environments
- Rotate API keys regularly
- Use strong, unique API keys
- Don't commit API keys to version control

### Network Security

- Use HTTPS/TLS for all production deployments
- Configure CORS appropriately (`CORS_ORIGINS`)
- Use rate limiting to prevent abuse
- Deploy behind a reverse proxy (nginx, Caddy) with additional security headers

### Configuration

- Review backend server configurations carefully
- Limit tool access to only what's necessary
- Use environment variables for sensitive configuration
- Never expose sensitive endpoints without authentication
- Set `ALLOW_INSECURE=0` in production

### Updates

- Keep MCP Gateway updated to the latest version
- Subscribe to security advisories
- Regularly update dependencies: `npm audit fix`
- Monitor for security patches

### Docker Security

- Use specific version tags, not `latest`
- Run containers as non-root user
- Scan images for vulnerabilities
- Keep base images updated

## Security Features

### Built-in Protection

- Rate limiting to prevent abuse
- Authentication and authorization
- Input validation and sanitization
- PII tokenization support
- Secure sandbox for code execution
- CORS protection

### Monitoring

- Health check endpoints
- Audit logging for sensitive operations
- Prometheus metrics for security monitoring

## Responsible Disclosure

We kindly ask that you:

- Give us reasonable time to address the issue before public disclosure
- Make a good faith effort to avoid privacy violations and data destruction
- Not exploit the vulnerability beyond what is necessary to demonstrate it
- Not access, modify, or delete data belonging to others

We commit to:

- Respond promptly to vulnerability reports
- Keep you informed about our progress
- Credit you appropriately (if desired)
- Not pursue legal action against researchers who follow this policy

## Contact

For security concerns, please use the methods described above rather than opening a public issue.

Thank you for helping keep MCP Gateway and its users safe!
