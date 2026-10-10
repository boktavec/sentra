FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
COPY --from=contracts . ./contracts
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" INTELLIGENCE_TOOL_CONTRACTS_DIR=/app/contracts
CMD ["python", "-m", "intelligence"]
