#!/bin/bash
# Deploy Kiln to Kubernetes

set -e

echo "🚀 Deploying Kiln to Kubernetes..."

# Apply the main configuration
kubectl apply -f kiln.yaml

# Wait for deployment to be ready
echo "⏳ Waiting for deployment to be ready..."
kubectl -n kiln rollout status deployment/kiln

# Get the pod status
echo "📊 Pod status:"
kubectl -n kiln get pods -l app=kiln

# Show the ingress URL
echo ""
echo "✅ Deployment complete!"
echo "🌐 Access Kiln at: https://kiln.fhir.me"
echo ""
echo "📝 To check logs:"
echo "kubectl -n kiln logs -f deployment/kiln"
echo ""
echo "🔧 To load terminology database (first time setup):"
echo "kubectl -n kiln exec -it deployment/kiln -- bun run server/scripts/load-terminology.ts"
