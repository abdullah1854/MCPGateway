---
name: infra-deploy
description: Infrastructure deployment for VPS, Docker, and cloud platforms. Activates for "deploy", "setup server", "docker", "coolify", "VPS", "SSH", "nginx", "production", "hosting" requests.
allowed-tools: [Bash, Read, Write, Edit, Grep]
---

# Infrastructure Deployment Protocol

## When This Skill Activates
- "Deploy this", "push to production", "setup server"
- "Docker", "containerize", "docker-compose"
- "VPS setup", "server configuration"
- "Coolify", "nginx", "reverse proxy"
- "SSL", "HTTPS", "Let's Encrypt"

## Pre-Deployment Checklist

### Before ANY Deployment:
```bash
# 1. Verify build works locally
npm run build  # or equivalent

# 2. Run tests
npm test

# 3. Check for env vars
cat .env.example  # Document required vars

# 4. Verify no secrets in code
grep -r "sk_live\|api_key\|password" --include="*.ts" --include="*.js" || echo "Clean"
```

## Docker Deployment

### Production Dockerfile (Node.js)
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser

COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/package.json ./

USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Docker Compose (Production)
```yaml
version: '3.8'

services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

## VPS Initial Setup

### 1. Security Hardening (Run First)
```bash
# Update system
apt update && apt upgrade -y

# Create deploy user
adduser deploy
usermod -aG sudo deploy

# Setup SSH keys (on local machine)
ssh-copy-id deploy@YOUR_SERVER_IP

# Disable password auth
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Setup firewall
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Install fail2ban
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
```

### 2. Docker Installation
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker deploy
newgrp docker
```

### 3. Coolify (Self-Hosted PaaS)
```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

## Nginx Reverse Proxy

### With SSL (Let's Encrypt)
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Get SSL Certificate
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

## Deployment Commands

### Build and Deploy
```bash
# Build image
docker build -t myapp:latest .

# Stop old container
docker stop myapp || true
docker rm myapp || true

# Run new container
docker run -d \
  --name myapp \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.production \
  myapp:latest

# Verify running
docker ps
docker logs myapp --tail 50
```

### Zero-Downtime Deployment
```bash
# Start new container on different port
docker run -d --name myapp-new -p 3001:3000 myapp:latest

# Wait for health check
sleep 10
curl -f http://localhost:3001/health

# Switch nginx upstream
# Then remove old container
docker stop myapp-old && docker rm myapp-old
```

## Monitoring

### Basic Health Check Endpoint
```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
```

### Log Commands
```bash
# Follow logs
docker logs -f myapp

# Last 100 lines
docker logs myapp --tail 100

# With timestamps
docker logs myapp -t --since 1h
```

## Rollback Procedure
```bash
# List available images
docker images myapp

# Rollback to previous
docker stop myapp
docker run -d --name myapp -p 3000:3000 myapp:previous-tag
```

## Security Checklist
- [ ] SSH key auth only (no passwords)
- [ ] Firewall enabled (ufw)
- [ ] Fail2ban running
- [ ] Non-root user for app
- [ ] Secrets in env vars, not code
- [ ] HTTPS with valid cert
- [ ] Security headers configured
- [ ] Regular security updates scheduled
