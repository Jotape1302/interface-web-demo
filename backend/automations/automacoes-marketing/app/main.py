"""Sobe a API da automação de e-mail marketing (uvicorn), com a geração agendada de sexta."""
import logging

import uvicorn

from app.config import settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [%(name)s]: %(message)s")
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run("app.api:app", host="0.0.0.0", port=settings.API_PORT)


if __name__ == "__main__":
    main()
