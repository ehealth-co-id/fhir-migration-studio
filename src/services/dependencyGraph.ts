/**
 * Dependency Graph — defines the migration order for all FHIR resource types.
 *
 * Each resource type must appear after all resource types it references.
 * This array is the single source of truth for migration order.
 *
 * Adding a new resource type requires only inserting it at the correct position
 * in DEPENDENCY_ORDER — no changes to pipeline logic are needed.
 *
 * Per docs/FHIR_RULES.md §Dependency Graph.
 */

import type { FhirResourceType } from '../types/fhir';

/**
 * Canonical migration order.
 * Resources are migrated completely (all batches) before moving to the next type.
 *
 * Questionnaire    — no external references
 * Patient          — may reference other Patients (handled via link.other two-stage)
 * Coverage         — references Patient, Organization
 * Schedule         — references HealthcareService
 * Slot             — references Schedule
 * Appointment      — references Patient, Practitioner, Slot, HealthcareService
 * Condition        — references Patient, Practitioner
 * Encounter        — references Appointment, Patient, Condition
 * Media            — references Patient, Practitioner, Encounter
 * AllergyIntolerance — references Patient, Practitioner
 * Procedure        — references Patient, Practitioner
 * ProcedureRequest — references Patient, Practitioner
 * Specimen         — references Appointment, Patient, ProcedureRequest
 * Observation      — references Patient, Practitioner, Specimen (and other
 *                    Observations via related.target — handled two-stage)
 * MedicationRequest  — references Patient, Practitioner
 * MedicationDispense — references Patient, Practitioner, MedicationRequest
 * ClinicalImpression — references Patient, Condition
 * Composition      — references Encounter, Patient, Practitioner, Condition,
 *                    Observation, AllergyIntolerance, ClinicalImpression,
 *                    MedicationRequest, MedicationDispense, Procedure, ProcedureRequest
 * Consent          — references Location, Appointment, Patient, Practitioner, Procedure
 * AuditEvent       — references Patient, Practitioner
 */
export const DEPENDENCY_ORDER: FhirResourceType[] = [
  'Questionnaire',
  'Patient',
  'Coverage',
  'Schedule',
  'Slot',
  'Appointment',
  'Condition',
  'Encounter',
  'Media',
  'AllergyIntolerance',
  'Procedure',
  'ProcedureRequest',
  'Specimen',
  'Observation',
  'MedicationRequest',
  'MedicationDispense',
  'ClinicalImpression',
  'Composition',
  'Consent',
  'AuditEvent',
];

/**
 * Returns the index of a resource type in the dependency order.
 * Returns -1 if the type is not in the order (e.g. reference-only types).
 */
export function getDependencyIndex(resourceType: FhirResourceType): number {
  return DEPENDENCY_ORDER.indexOf(resourceType);
}

/**
 * Sort a list of resource types by their dependency order.
 * Types not in DEPENDENCY_ORDER are placed at the end (stable sort).
 */
export function sortByDependencyOrder(types: FhirResourceType[]): FhirResourceType[] {
  return [...types].sort((a, b) => {
    const ia = getDependencyIndex(a);
    const ib = getDependencyIndex(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
