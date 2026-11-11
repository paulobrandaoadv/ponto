type Employee = { id: string; name: string; shift: string; status: string };
type Entry = { employeeId: string; type: string; date: string; time: string; status: string };

export function dashboardPeople<T extends Employee>(employees: T[], entries: Entry[], today: string) {
  const collaborators = employees.filter((employee) => employee.status !== 'Arquivado');
  const firstEntries = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.date !== today || entry.type !== 'entrada' || entry.status === 'rejected') continue;
    const previous = firstEntries.get(entry.employeeId);
    if (!previous || entry.time < previous.time) firstEntries.set(entry.employeeId, entry);
  }
  const present = collaborators.flatMap((employee) => {
    const entry = firstEntries.get(employee.id);
    return entry ? [{ ...employee, entryTime: entry.time }] : [];
  });
  const late = present.flatMap((employee) => {
    const scheduledStart = employee.shift.match(/\d{2}:\d{2}/)?.[0];
    return scheduledStart && employee.entryTime > scheduledStart
      ? [{ ...employee, scheduledStart }]
      : [];
  });
  const missing = collaborators.filter((employee) => !firstEntries.has(employee.id));
  return { collaborators, present, late, missing };
}
