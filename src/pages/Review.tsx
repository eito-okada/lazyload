import { useNavigate } from 'react-router-dom';
import TaskCard from '../components/TaskCard';
import { useTasks } from '../context/TaskContext';
import type { Task } from '../types/Task';

export default function Review() {
  const { tasks, setTasks } = useTasks();
  const navigate = useNavigate();

  function updateTask(updated: Task) {
    setTasks(tasks.map((t) => (t.id === updated.id ? updated : t)));
  }

  function deleteTask(id: string) {
    setTasks(tasks.filter((t) => t.id !== id));
  }

  return (
    <section className="page review-page">
      <h1>Review Tasks</h1>
      {tasks.length === 0 ? (
        <p>No tasks yet. Upload a screenshot first.</p>
      ) : (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} editable onChange={updateTask} onDelete={deleteTask} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="cta-button"
        disabled={tasks.length === 0}
        onClick={() => navigate('/schedule')}
      >
        Generate Study Plan
      </button>
    </section>
  );
}
