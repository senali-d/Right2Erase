.PHONY: setup reset mcp-billing-http mcp-db-http mcp-storage-http test

setup:
	./scripts/setup.sh

reset:
	./scripts/demo-reset.sh

mcp-billing-http:
	cd fixture && npm run mcp:billing:http

mcp-db-http:
	npm run mcp:db:http

mcp-storage-http:
	npm run mcp:storage:http

test:
	npm test
