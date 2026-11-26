#!/bin/sh
# First start of an empty postgres volume: one role + database for Ergo's
# history and one for the a09f account service. The api also reads Ergo's
# history (message search), so it gets read access to that database.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE ROLE ergo LOGIN PASSWORD '${ERGO_DB_PASSWORD}';
CREATE ROLE a09f LOGIN PASSWORD '${A09F_DB_PASSWORD}';
CREATE DATABASE ergo_history OWNER ergo;
CREATE DATABASE a09f OWNER a09f;
SQL
# Tables Ergo creates later (as role ergo) are readable by a09f.
psql -v ON_ERROR_STOP=1 -U postgres -d ergo_history <<SQL
GRANT CONNECT ON DATABASE ergo_history TO a09f;
GRANT USAGE ON SCHEMA public TO a09f;
ALTER DEFAULT PRIVILEGES FOR ROLE ergo IN SCHEMA public GRANT SELECT ON TABLES TO a09f;
SQL
