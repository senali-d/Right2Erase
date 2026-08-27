.PHONY: setup reset

setup:
	cd fixture && npm install
	cd fixture && npm run up
	cd fixture && npm run seed

reset:
	cd fixture && npm run reset
