.PHONY: setup reset

setup:
	cd fixture && npm install && npm run up && npm run seed

reset:
	cd fixture && npm run reset
