.PHONY: setup reset mcp-billing-http

setup:
	cd fixture && npm install && npm run up && npm run seed

reset:
	cd fixture && npm run reset

mcp-billing-http:
	cd fixture && npm run mcp:billing:http
