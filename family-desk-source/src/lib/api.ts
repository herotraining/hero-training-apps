// One data layer with two backs: Supabase for real use, built-in made-up data when VITE_MOCK=1.
import type { JackrabbitLine, Attendance, CareInput, Child, ChildInput, ClassWalletDeposit, Closure, ClosureInput, EnrollmentInput, EsaInvoice, Family, FamilyInput, FeedItem, GuardianInput, Program, ProgramInput, Profile, RosterRow, Site, Staff, StripePicture, TrainerPay } from "../types";

export interface Api {
  mock: boolean;
  profile(): Promise<Profile>;
  sites(): Promise<Site[]>;
  programs(): Promise<Program[]>;
  families(): Promise<Family[]>;
  family(id: string): Promise<Family | null>;
  rosterFor(weekday: number): Promise<{ program: Program; rows: RosterRow[] }[]>;
  saveFamily(f: FamilyInput): Promise<string>;
  saveGuardian(g: GuardianInput): Promise<void>;
  removeGuardian(id: string): Promise<void>;
  saveChild(c: ChildInput): Promise<string>;
  saveCare(childId: string, care: CareInput): Promise<void>;
  setAgreement(familyId: string, kind: string, signedBy: string | null): Promise<void>;
  saveEnrollment(e: EnrollmentInput): Promise<void>;
  removeEnrollment(id: string): Promise<void>;
  jackrabbitHistory(familyId: string): Promise<JackrabbitLine[]>;
  attendanceFor(dateIso: string): Promise<Attendance[]>;
  markAttendance(enrollmentId: string, dateIso: string, status: "present" | "absent" | null): Promise<void>;
  allPrograms(): Promise<Program[]>;
  saveProgram(p: ProgramInput): Promise<void>;
  saveClosure(c: ClosureInput): Promise<void>;
  removeClosure(id: string): Promise<void>;
  closures(fromIso: string): Promise<Closure[]>;
  esaInvoices(): Promise<EsaInvoice[]>;
  stripeFamily(familyId: string): Promise<StripePicture>;
  createEsaInvoices(classMonth: string, familyId?: string): Promise<{ class_month: string; created: any[]; skipped: any[] }>;
  markEsaPaid(id: string, reason: string, classwalletDepositId?: string): Promise<void>;
  feed(): Promise<FeedItem[]>;
  setFeedStatus(id: string, status: FeedItem["status"]): Promise<void>;
  classwalletDeposits(sinceIso: string): Promise<ClassWalletDeposit[]>;
  setDepositStatus(id: string, status: ClassWalletDeposit["status"], note?: string | null): Promise<void>;
  trainerPay(sinceIso: string): Promise<TrainerPay[]>;
  staff(): Promise<Staff[]>;
  addStaff(s: { email: string; name: string; role: Staff["role"]; site_id: string | null }): Promise<void>;
  setStaffActive(id: string, active: boolean): Promise<void>;
  coachAssignments(): Promise<{ staff_id: string; program_id: string }[]>;
  setCoachAssignments(staffId: string, programIds: string[]): Promise<void>;
  staffSignin(staffId: string, action: "create" | "reset" | "reset_2fa"): Promise<{ ok: boolean; email?: string; password?: string; removed?: number }>;
  changePassword(newPassword: string): Promise<void>;
  auditRecent(): Promise<{ id: number; at: string; actor_email: string | null; action: string; entity: string; entity_id: string | null; reason: string | null }[]>;
}

export const IS_MOCK = import.meta.env.VITE_MOCK === "1";

let impl: Api | null = null;
export async function api(): Promise<Api> {
  if (impl) return impl;
  impl = IS_MOCK ? (await import("./mock")).mockApi() : (await import("./supabaseApi")).supabaseApi();
  return impl;
}

export type { Child };
