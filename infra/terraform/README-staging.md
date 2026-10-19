# Staging Infrastructure Provisioning

This directory contains declarative Terraform configuration for provisioning the Rentars staging environment.

## Quick Start

1. Initialize Terraform:
```bash
cd infra/terraform
terraform init
```

2. Validate configuration:
```bash
terraform validate
```

3. Plan changes:
```bash
terraform plan -var-file=staging.tfvars \
  -var="backend_image=<registry>/rentars-backend:staging" \
  -var="frontend_image=<registry>/rentars-web:staging" \
  -var="secret_arn_supabase_service_role_key=<arn>" \
  -var="secret_arn_jwt_secret=<arn>" \
  -var="secret_arn_trustless_work_api_key=<arn>" \
  -var="secret_arn_smtp_pass=<arn>" \
  -var="secret_arn_hcaptcha_secret_key=<arn>" \
  -var="secret_arn_metrics_token=<arn>" \
  -var="secret_arn_stellar_admin_secret=<arn>"
```

4. Apply (requires approval):
```bash
terraform apply -var-file=staging.tfvars [vars...]
```

## Requirements

- Terraform >= 1.7.0
- AWS CLI configured with appropriate permissions
- Secret ARNs from AWS Secrets Manager (see secrets.reference.md)
- Container images pushed to ECR

## Notes

- All secrets are referenced via ARN only; no plaintext values in config
- Destructive changes are blocked by CI policy for stateful resources
- State is stored in S3 with DynamoDB locking (see backend config)
