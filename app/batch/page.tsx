import { redirect } from 'next/navigation';

// Batch upload is now part of the one Submit page, which takes one invoice or a whole stack.
export default function BatchRedirect() {
  redirect('/submit');
}
