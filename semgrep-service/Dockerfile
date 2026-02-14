FROM python:3.12-slim

RUN pip install --no-cache-dir semgrep fastapi uvicorn

COPY . /app
WORKDIR /app

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
