import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-3 px-4 py-20 text-center">
      <h1 className="font-display text-[28px] font-bold">Not found</h1>
      <Link href="/" className="font-semibold text-board underline underline-offset-4">
        Back to the shop
      </Link>
    </main>
  );
}
