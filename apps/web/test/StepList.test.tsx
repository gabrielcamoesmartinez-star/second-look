import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepList } from '../src/components/StepList';

const step = (over: object) => ({ id: 1, audit_id: '00000000-0000-4000-8000-000000000000', attempt: 0, started_at: null, finished_at: null, error_code: null, detail: null, ...over });

describe('StepList', () => {
  it('shows retry attempts and plain-language errors', () => {
    render(
      <StepList
        steps={[
          step({ step: 'fetch', status: 'done' }),
          step({ id: 2, step: 'performance', status: 'retrying', attempt: 2 }),
          step({ id: 3, step: 'seo', status: 'failed', error_code: 'blocked_by_robots' }),
        ] as never}
      />,
    );
    expect(screen.getByText('Retrying · attempt 2 of 3')).toBeInTheDocument();
    expect(screen.getByText(/asks crawlers not to visit/)).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});
