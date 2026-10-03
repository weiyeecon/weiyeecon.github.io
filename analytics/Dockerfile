FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -u 10001 -m analyst && mkdir /app/data && chown analyst /app/data
COPY app.py manage.py ./
COPY web ./web
USER analyst
EXPOSE 8100
CMD ["uvicorn", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers", "--forwarded-allow-ips", "172.30.0.2", "--no-access-log"]
