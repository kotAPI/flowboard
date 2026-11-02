.PHONY: up down reset seed test test-api test-web logs cli

up:            ## build and start everything (http://localhost:8080)
	docker compose up --build

down:          ## stop (keeps data)
	docker compose down

reset:         ## stop and delete the database volume
	docker compose down -v

seed:          ## wipe all data and re-seed the demo workspace
	docker compose exec api npx tsx src/seed.ts --reset

test: test-api test-web

test-api:      ## API unit + integration tests against the flowboard_test database
	docker compose --profile test run --rm --build api-test

test-web:      ## UI component tests
	docker compose --profile test run --rm --build web-test

logs:
	docker compose logs -f api worker

cli:           ## e.g. make cli ARGS="board lst_sprint_12"
	node cli/flowboard.mjs $(ARGS)
