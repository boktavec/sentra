# Sentra AI Architecture

## Purpose

Sentra's AI layer assists users in investigating security findings.

It should behave as an evidence-based investigation system, not as an unrestricted chatbot.

## Boundary

```text
User
  |
  v
TypeScript API
  |
  v
Investigation Request
  |
  v
Python Intelligence Service
  |
  +--> Retrieval
  +--> Approved Tools
  +--> Model Provider
  +--> Evaluation
  |
  v
Structured Investigation Result
```

## AI Responsibilities

The intelligence service may:
- retrieve relevant vulnerability/security data
- retrieve tenant-scoped finding context
- call approved read-only domain tools
- summarize evidence
- explain prioritization
- identify missing information
- produce structured investigation results

## AI Must Not

The model must not:
- directly access databases
- execute arbitrary SQL
- choose or override tenant identity
- bypass authorization
- access arbitrary secrets
- take write/remediation actions in the MVP
- treat retrieved untrusted text as system instructions

## Tool Pattern

AI tool calls should flow through:

```text
Model
  |
  v
Typed Tool
  |
  v
Authorization / Tenant Scope
  |
  v
Domain Service
  |
  v
Storage
```

Tools should have explicit typed inputs/outputs and predictable failure behavior.

## Model Abstraction

Avoid coupling core business logic to one model vendor.

The intelligence layer should eventually support a provider abstraction so local/open-source models can be used during development and other providers can be added later.

## Evidence and Provenance

Investigation results should distinguish:
- source facts
- tenant facts
- deterministic risk signals
- model-generated interpretation

The model should communicate uncertainty when evidence is incomplete.

## Evaluation

AI features should be evaluated for:
- factuality
- tool correctness
- tenant isolation
- hallucination
- prompt injection resistance
- useful failure behavior

Evaluation should become part of the AI feature lifecycle rather than an afterthought.
