import type { Metadata } from 'next';
import { VerifyForm } from './verify-form';

export const metadata: Metadata = {
  title: 'Verify a certificate',
  description: 'Check that an EthiopiaLearn certificate is genuine by its certificate ID.',
  alternates: { canonical: '/verify' },
};

export default function VerifyLandingPage() {
  return <VerifyForm />;
}
