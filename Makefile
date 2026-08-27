.PHONY: setup

setup:
	cd fixture && npm install
	cd fixture && npm run up
	cd fixture && npm run seed
