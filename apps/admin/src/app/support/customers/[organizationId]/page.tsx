import CustomerDetail from './customer-detail';

export default async function SupportCustomerPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <CustomerDetail organizationId={organizationId} />;
}
