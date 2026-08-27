.PHONY: setup reset mcp-billing-http test

setup:
	./scripts/setup.sh

reset:
	./scripts/demo-reset.sh

mcp-billing-http:
	cd fixture && npm run mcp:billing:http

test:
	npm test
