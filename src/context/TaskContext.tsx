import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import type { Task } from '../types/Task';
import * as tasksApi from '../services/tasks';

interface TaskContextValue {
  /** The current upload's extracted tasks, being edited on Review. Not yet in the DB. */
  draftTasks: Task[];
  setDraftTasks: (tasks: Task[]) => void;
  /** Every task the signed-in user has ever saved, across all uploads. */
  allTasks: Task[];
  loadingAllTasks: boolean;
  /** Persists draftTasks as a new import. Returns the import id (for undo) and saved tasks. */
  saveDraftTasks: (sourceNote?: string) => Promise<{ importId: string; tasks: Task[] }>;
  /** Creates a single manually-added item (task or event) and shows it immediately. */
  createItem: (item: Partial<Task>) => Promise<Task>;
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  undoImport: (importId: string) => Promise<void>;
  refreshAllTasks: () => Promise<void>;
}

const TaskContext = createContext<TaskContextValue | undefined>(undefined);

export function TaskProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [draftTasks, setDraftTasks] = useState<Task[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loadingAllTasks, setLoadingAllTasks] = useState(false);

  const refreshAllTasks = useCallback(async () => {
    if (!user) {
      setAllTasks([]);
      return;
    }
    setLoadingAllTasks(true);
    try {
      setAllTasks(await tasksApi.fetchTasks());
    } finally {
      setLoadingAllTasks(false);
    }
  }, [user]);

  useEffect(() => {
    refreshAllTasks();
  }, [refreshAllTasks]);

  async function saveDraftTasks(sourceNote?: string) {
    if (!user) throw new Error('Must be signed in to save tasks');
    const result = await tasksApi.saveImport(user.id, draftTasks, sourceNote);
    setDraftTasks([]);
    await refreshAllTasks();
    return result;
  }

  async function createItem(item: Partial<Task>) {
    if (!user) throw new Error('Must be signed in to add items');
    const saved = await tasksApi.createItem(user.id, item);
    setAllTasks((prev) => [...prev, saved]);
    return saved;
  }

  async function updateTask(taskId: string, updates: Partial<Task>) {
    await tasksApi.updateTask(taskId, updates);
    setAllTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t)));
  }

  async function deleteTask(taskId: string) {
    await tasksApi.deleteTask(taskId);
    setAllTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  async function undoImport(importId: string) {
    await tasksApi.deleteImport(importId);
    await refreshAllTasks();
  }

  return (
    <TaskContext.Provider
      value={{
        draftTasks,
        setDraftTasks,
        allTasks,
        loadingAllTasks,
        saveDraftTasks,
        createItem,
        updateTask,
        deleteTask,
        undoImport,
        refreshAllTasks,
      }}
    >
      {children}
    </TaskContext.Provider>
  );
}

export function useTasks() {
  const context = useContext(TaskContext);
  if (!context) {
    throw new Error('useTasks must be used within a TaskProvider');
  }
  return context;
}
