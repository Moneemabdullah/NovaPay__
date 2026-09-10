SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml
DEV_COMPOSE := docker compose -f infra/docker-compose.dev.yml
SERVICES := account transaction ledger fx payroll admin api-gateway
DB_SERVICES := account transaction ledger fx payroll admin

.PHONY: help up down logs ps build migrate generate test init-db \
        typecheck coverage security-audit check lint integration-test \
        dev-up dev-down dev-logs dev-ps dev-build

help:
	@echo "NovaPay — easy-run targets:"
	@echo ""
	@echo "  Production (full stack with monitoring):"
	@echo "  make up         		Start the full stack (Postgres, Redis, all services, gateway, monitoring)"
	@echo "  make build-up   		Build + start the full stack (force rebuild)"
	@echo "  make down      		Stop and remove all containers"
	@echo "  make logs      		Tail logs from all containers"
	@echo "  make ps         		Show running containers"
	@echo "  make build      		Build all images without starting"
	@echo "  make init-db    		Start only the infra DBs (Postgres + Redis)"
	@echo "  make migrate    		Apply Prisma migrations to each service DB"
	@echo "  make generate   		Run prisma generate in each DB service"
	@echo "  make test       		Run the vitest suite in every service"
	@echo "  make integration-test  	Run the integration tests in every service"
	@echo "  make typecheck  		Run the TypeScript typecheck (tsc --noEmit) in every service"
	@echo "  make coverage   		Run vitest with v8 coverage in every service (report-only, no threshold)"
	@echo "  make security-audit  	Run npm audit at high+ severity in every service (report-only, never fails)"
	@echo "  make check      		Run typecheck + lint + unit tests + integration tests (stops on first failure)"
	@echo "  make lint       		Run the linter in every service"
	@echo "  make pre-push 		Run all pre-push checks (unit tests, integration tests, typecheck, lint, security audit)"
	@echo ""
	@echo "  Development (fast, no rebuilds):"
	@echo "  make dev-up   		Install deps (once) + start dev stack"
	@echo "  make dev-down 		Stop and remove dev containers"
	@echo "  make dev-logs 		Tail dev logs"
	@echo "  make dev-ps   		Show dev containers"
	@echo "  make dev-build 		Rebuild deps (after package.json changes)"
up:
	$(COMPOSE) up -d

build-up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

build:
	$(COMPOSE) build

init-db:
	$(COMPOSE) up -d postgres redis

migrate:
	@for s in $(DB_SERVICES); do \
		echo "==> prisma migrate deploy: $$s-service"; \
		(cd services/$$s-service && npx prisma migrate deploy) || exit 1; \
	done

generate:
	@for s in $(DB_SERVICES); do \
		echo "==> prisma generate: $$s-service"; \
		(cd services/$$s-service && npx prisma generate) || exit 1; \
	done

test:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		echo "==> vitest: $$s"; \
		(cd "$$d" && npx vitest run) || exit 1; \
	done

integration-test:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		if [ -f "$$d/vitest.integration.config.ts" ]; then \
			echo "==> vitest integration: $$s"; \
			(cd "$$d" && npx vitest run --config vitest.integration.config.ts) || exit 1; \
		else \
			echo "==> vitest integration: $$s — skipped (no integration config)"; \
		fi; \
	done

lint:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		echo "==> eslint: $$s"; \
		(cd "$$d" && npx eslint . --ext .ts,.tsx) || exit 1; \
	done

typecheck:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		echo "==> tsc --noEmit: $$s"; \
		(cd "$$d" && npm run build) || exit 1; \
	done

coverage:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		echo "==> vitest coverage: $$s"; \
		(cd "$$d" && npm run test:coverage) || exit 1; \
	done

# Mirrors CI (ci-tests.yml): audit is report-only (continue-on-error)
# because the tree carries pre-existing high/critical transitives.
security-audit:
	@for s in $(SERVICES); do \
		d="services/$$s-service"; \
		[ -d "$$d" ] || d="services/$$s"; \
		echo "==> npm audit (high+, report-only): $$s"; \
		(cd "$$d" && npm audit --audit-level=high) || echo "==> audit findings above: $$s (report-only, does not fail)"; \
	done

# Local equivalent of the CI gating pipeline (ci-quality + ci-tests + lint):
# typecheck + lint + unit tests + integration tests. Stops on first failure.
check: typecheck lint test integration-test


pre-push:
	@echo "==> Running pre-push checks..."
	@$(MAKE) test
	@$(MAKE) integration-test
	@$(MAKE) typecheck
	@$(MAKE) lint
	@$(MAKE) security-audit
	@echo "==> All pre-push checks passed."


# ── Development targets ─────────────────────────────────────────────────────

dev-up:
	$(DEV_COMPOSE) up -d

dev-down:
	$(DEV_COMPOSE) down

dev-logs:
	$(DEV_COMPOSE) logs -f

dev-ps:
	$(DEV_COMPOSE) ps

dev-build:
	$(DEV_COMPOSE) up -d --force-recreate deps
