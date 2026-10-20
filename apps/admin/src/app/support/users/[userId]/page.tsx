import UserDetail from './user-detail';

export default async function SupportUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserDetail userId={userId} />;
}
