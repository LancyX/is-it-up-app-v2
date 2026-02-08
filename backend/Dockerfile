FROM python:3.12-slim

WORKDIR /app

# Install poetry
ENV POETRY_VERSION=1.8.0
ENV POETRY_HOME=/opt/poetry
ENV PATH="$POETRY_HOME/bin:$PATH"
RUN pip install --no-cache-dir poetry

# Copy dependency files
COPY pyproject.toml poetry.lock* ./

# Install deps (no dev)
RUN poetry config virtualenvs.create false && poetry install --no-interaction --no-ansi --no-root

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
