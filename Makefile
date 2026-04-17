format:
	npx prettier --write .

check:
	npx prettier --check .
	node --check server.mjs
	ARKADE_DISABLE_SERVER=1 node -e "import('./server.mjs').catch(err => { console.error(err); process.exit(1) })"

all: format check
