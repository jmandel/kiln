# Kiln Kubernetes Deployment

This directory contains Kubernetes manifests for deploying Kiln to a K8s cluster.

## Prerequisites

- Kubernetes cluster (1.19+)
- kubectl configured to access your cluster
- cert-manager installed (for TLS certificates)
- nginx-ingress controller installed
- Domain configured (default: kiln.fhir.me)

## Files

- `kiln.yaml` - Main Kubernetes manifest with all resources
- `deploy.sh` - Helper script for deployment
- `app-with-debug.yaml` - Alternative configuration with debug logging enabled

## Quick Deploy

```bash
# Deploy everything
./deploy.sh

# Or manually
kubectl apply -f kiln.yaml
```

## Configuration

### Secrets

Create a secret with your LLM API key:

```bash
kubectl -n kiln create secret generic kiln-secrets \
  --from-literal=TASK_DEFAULT_API_KEY=your-openrouter-api-key
```

### First-Time Setup

After deployment, load the terminology database:

```bash
# Execute inside the pod
kubectl -n kiln exec -it deployment/kiln -- bun run server/scripts/load-terminology.ts
```

This process takes 5-10 minutes and loads LOINC, SNOMED CT, RxNorm, and CVX vocabularies.

### Resource Requirements

- **Memory**: 2-6 GiB (6 GiB limit for validator + terminology operations)
- **CPU**: 0.5-2 cores
- **Storage**:
  - 5 GiB for terminology database
  - 10 GiB for job artifacts and temp data

### Environment Variables

Configured via ConfigMap (`kiln-config`):
- `NODE_ENV`: production
- `PORT`: 3500
- `VALIDATOR_HEAP`: 4g (Java heap for FHIR validator)
- `TERMINOLOGY_DB_PATH`: /data/terminology.sqlite

## Monitoring

```bash
# Check deployment status
kubectl -n kiln get all

# View logs
kubectl -n kiln logs -f deployment/kiln

# Check pod details
kubectl -n kiln describe pod -l app=kiln

# Health check
curl https://kiln.fhir.me/health
```

## Updating

The GitHub Actions workflow automatically builds and pushes new images on commits to main:

```bash
# Restart deployment to pull latest image
kubectl -n kiln rollout restart deployment/kiln

# Watch rollout status
kubectl -n kiln rollout status deployment/kiln
```

## Troubleshooting

### Pod Won't Start

Check if the terminology database is loaded:
```bash
kubectl -n kiln exec -it deployment/kiln -- ls -la /data/
```

### Out of Memory

Increase memory limits in `kiln.yaml`:
```yaml
resources:
  limits:
    memory: "8Gi"  # Increase as needed
```

### Validator Issues

Check Java heap settings:
```bash
kubectl -n kiln exec -it deployment/kiln -- env | grep VALIDATOR_HEAP
```

## Architecture

```
┌─────────────────┐
│   Ingress       │
│ kiln.fhir.me    │
└────────┬────────┘
         │
┌────────▼────────┐
│    Service      │
│   kiln:80       │
└────────┬────────┘
         │
┌────────▼────────┐
│   Deployment    │
│   kiln (1 pod)  │
├─────────────────┤
│ - Bun.js server │
│ - React UI      │
│ - FHIR Validator│
│ - SQLite DB     │
└────────┬────────┘
         │
┌────────▼────────┐
│      PVCs       │
├─────────────────┤
│ - terminology   │
│ - job-data      │
└─────────────────┘
```

## Security Notes

- Runs as non-root user (UID 1000)
- Read-only root filesystem recommended for production
- Secrets managed separately from main config
- Network policies can be added to restrict traffic