"""Additive schema v4 migration for SQLite / PostgreSQL workspaces."""
import argparse

from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable

from .config import Settings
from .db import Database, meta


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-sql", action="store_true")
    args = parser.parse_args()
    if args.print_sql:
        for table in meta.sorted_tables:
            print(str(CreateTable(table).compile(dialect=postgresql.dialect())).strip() + ";")
            for index in table.indexes:
                print(str(CreateIndex(index).compile(dialect=postgresql.dialect())).strip() + ";")
        return
    settings = Settings()
    settings.validate()
    database = Database(settings)
    database.initialize(settings.admin_password)
    database.engine.dispose()
    print("schema_version=4 已就绪；保留既有记录，无训练数据种子。")


if __name__ == "__main__":
    main()
