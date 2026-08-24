# Goal

Refactor the FHIR migration process to avoid HTTP 413 (Content Too Large) while making the migration easier to monitor, resume, and retry.

The current implementation builds one massive Transaction Bundle (~15,000 resources). This must be replaced with a dependency-driven migration pipeline that migrates resources by resource type in small Transaction Bundles.

The implementation must remain fully compatible with FHIR Transaction Bundles.

---

# Current Architecture

The destination server already contains:

* Practitioner
* Location
* HealthcareService
* Organization

Mappings for these resources already exist.

The migration imports:

* Patient
* Coverage
* Schedule
* Slot
* Questionnaire
* Appointment
* Encounter
* Composition
* Condition
* Observation
* AllergyIntolerance
* ClinicalImpression
* MedicationRequest
* MedicationDispense
* Procedure
* ProcedureRequest
* Specimen
* Immunization
* Consent
* AuditEvent
* Media

---

# Resource Relationships

## Patient

A Patient may have:

* one or more Coverages
* many Appointments
* references to another Patient via `Patient.link.other`

## Coverage

References:

* Patient
* Organization

## Schedule

References:

* HealthcareService

## Slot

References:

* Schedule

## Appointment

References:

* Patient
* Practitioner
* Slot
* HealthcareService

## Encounter

References:

* Appointment
* Patient
* Condition

One Encounter may produce one or more Compositions.

## Media

References:

* Patient
* Practitioner
* Encounter

## Composition

References:

* Encounter
* Patient
* Practitioner
* Condition
* Observation
* Immunization
* AllergyIntolerance
* ClinicalImpression
* MedicationRequest
* MedicationDispense
* Procedure
* ProcedureRequest

## Other Resources

Condition

* references Patient
* Practitioner

Observation

* references Patient
* Practitioner
* references another Observation via `Observation.related.target` (e.g. derived-from / has-member)

AllergyIntolerance

* references Patient
* Practitioner

ClinicalImpression

* references Patient
* Condition

MedicationRequest

* references Patient
* Practitioner

MedicationDispense

* references Patient
* Practitioner
* MedicationRequest

Procedure

* references Patient
* Practitioner

ProcedureRequest

* references Patient
* Practitioner

Specimen

* references Appointment (via `related-appointment` extension `valueReference`)
* Patient (subject)
* ProcedureRequest (request)

Immunization

* references Patient
* Encounter
* Practitioner (practitioner[].actor)
* Observation (reaction[].detail)

Consent

* references

  * Location
  * Appointment
  * Patient
  * Practitioner
  * Procedure

AuditEvent

* references

  * Patient
  * Practitioner

Questionnaire

* no references

Media

* references Patient
* Practitioner
* Encounter

---

# New Migration Strategy

Do NOT build one giant Transaction Bundle.

Instead, migrate resources by dependency order.

Each resource type should be migrated completely before moving to the next resource type.

Each Transaction Bundle should contain a configurable maximum number of resources (default: 100).

---

# Dependency Graph

The migration order must respect resource dependencies.

Implement the dependency graph as configuration rather than hardcoded business logic whenever possible.

Current dependency order:

Questionnaire

↓

Patient

↓

Coverage

↓

Schedule

↓

Slot

↓

Appointment

↓

Condition

↓

Encounter

↓

Media

↓

AllergyIntolerance

↓

Procedure

↓

ProcedureRequest

↓

Specimen

↓

Observation

↓

Immunization

↓

MedicationRequest

↓

MedicationDispense

↓

ClinicalImpression

↓

Composition

↓

Consent

↓

AuditEvent

The implementation should make it easy to insert additional resource types in the future.

---

# Transaction Bundles

Continue using FHIR Transaction Bundles.

Each bundle should only contain resources of a single resource type.

Example:

Bundle #1

100 Patient

Bundle #2

100 Patient

...

Bundle #120

100 Patient

Then continue with Coverage.

Do NOT mix different resource types inside the same Transaction Bundle.

## Inline Binary Content (HAPI-0389)

Resources with inline binary attachments (e.g. `Patient.photo[].data`, `Media.content.data`)
are stored by HAPI FHIR as `BinaryStorageEntity` keyed by a content hash.

If two resources inside the same Transaction Bundle share identical inline content,
HAPI fails the whole bundle with:

```
HAPI-0389: EntityExistsException: A different object with the same identifier
value was already associated with the session (BinaryStorageEntity)
```

The bundle splitter is therefore binary-aware: whenever an entry's inline attachment
data collides with an earlier entry in the same bundle, the batch is split and the
colliding entry starts a new bundle. The normal bundle size still applies when no
collisions occur.

This protection applies to every upload path (dependency migration, Patient.link
restore PUT bundles, and NDJSON import).

Known server-side defect (HAPI <= 6.x): `BinaryStorageInterceptor` keeps deferred
blob targets in TransactionDetails-scoped state and re-stores every previously
deferred blob once per additional resource committed in the same transaction.
Any transaction containing >= 2 resources with inline binary data therefore fails
with HAPI-0389 even when the contents are completely different. Verified against
HAPI FHIR Server 6.4.4 (DSTU3) tenant servers; fixed upstream when the deferred
list moved to per-resource userData.

As a safety net, the uploader detects HAPI-0389 BinaryStorageEntity failures,
marks that target server as binary-unsafe for the app session, retries the failed
bundle as single-entry transactions, and sends all remaining bundles
single-entry. Single-entry transactions are always safe (the deferred list holds
at most one entry), so one collision can never drop resources from the migration.

---

# Resource Mapping

The destination server generates new logical IDs.

Never assume IDs remain the same.

Implement a generic Resource Mapping Service.

Example API

save(resourceType, oldId, newId)

get(resourceType, oldId)

exists(resourceType, oldId)

The mapping service must work for every resource type.

---

# Patient.link.other

Patient resources may reference other Patient resources.

Handle this using two migration stages.

Stage 1

Create all Patient resources without `Patient.link.other`.

Collect every Patient ID mapping.

Stage 2

Update Patient resources and restore `Patient.link.other` using mapped Patient IDs.

---

# Observation.related

Observation resources may reference other Observation resources via `Observation.related.target`.

The destination server rejects the reference while the target Observation ID is not yet known (HAPI-1094: Resource Observation/xxx not found).

Handle this using two migration stages, same as `Patient.link.other` and `Composition.relatesTo`.

Stage 1

Create all Observation resources without `Observation.related`.

Collect every Observation ID mapping.

Stage 2

Update Observation resources and restore `Observation.related` using mapped Observation IDs.

---

# Reference Rewriting

Before a resource is added into a Transaction Bundle,

rewrite every reference using the mapping service.

Examples:

* Patient
* Appointment
* Encounter
* MedicationRequest
* Schedule
* Slot
* Practitioner
* HealthcareService
* Location
* Organization

must all be rewritten using destination IDs.

No reference should still point to an old server ID after migration.

---

# Progress Tracking

The migration should expose progress by resource type.

Example:

Patient

11,500 / 12,000

Coverage

1,800 / 2,000

Appointment

7,200 / 8,100

Encounter

7,100 / 8,100

Composition

6,950 / 8,100

---

# Retry Strategy

Every Transaction Bundle should be independently retryable.

If one bundle fails,

only that bundle should be retried.

Successfully migrated bundles should never be migrated again.

---

# Architecture

Refactor the implementation into independent components.

Suggested components:

* Migration Orchestrator
* Dependency Graph
* Resource Loader
* Transaction Bundle Builder
* Resource Mapping Service
* Reference Rewriter
* Progress Tracker
* Retry Manager

Avoid duplicated logic.

The migration pipeline should be generic enough to support additional FHIR resource types with minimal code changes.

---

# Configuration

Bundle size must be configurable.

Migration order should be configurable.

Retry policy should be configurable.

Logging verbosity should be configurable.

---

# Expected Result

The final implementation should:

* eliminate HTTP 413
* continue using Transaction Bundles
* migrate resources according to dependency order
* rewrite every reference correctly
* maintain a generic old ID → new ID mapping for every resource type
* support Patient self-references
* support progress tracking per resource type
* support retry per bundle
* keep the implementation modular, maintainable, and extensible
