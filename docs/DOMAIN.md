# Domain

Supported Resources

- Patient
- Appointment
- Encounter
- Composition
- Condition
- Observation
- AllergyIntolerance
- ClinicalImpression
- MedicationRequest
- MedicationDispense
- Procedure
- ProcedureRequest
- Specimen
- Immunization
- Media
<!-- - Practitioner
- Location
- HealthcareService -->

Rules

- 1 Encounter = 1 Composition
- Patient identified by NIK / MRN
- Practitioner, Location and HealthcareService is already exist in destination server
- Preserve business identifiers during migration.
