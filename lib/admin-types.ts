export type SharedSettings = {
  employeeId: string;
  notes: string;
  metadata: Record<string, unknown>;
  hasToken: boolean;
  updatedAt: string | null;
};

export type SharedCredentials = {
  token: string | null;
  employeeId: string;
  notes: string;
  metadata: Record<string, unknown>;
};
