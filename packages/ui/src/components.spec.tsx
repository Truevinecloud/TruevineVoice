import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { Select } from './Select.js';
import { Checkbox } from './Checkbox.js';
import { Badge } from './Badge.js';
import { Card } from './Card.js';
import { Table } from './Table.js';
import { Modal } from './Modal.js';
import { Notification } from './Notification.js';
import { Loading } from './Loading.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { ConfirmationDialog } from './ConfirmationDialog.js';
import { Pagination } from './Pagination.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders children and applies variant class', () => {
    render(<Button variant="primary">Click me</Button>);
    const button = screen.getByRole('button', { name: 'Click me' }) as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.className).toContain('button--primary');
  });

  it('applies disabled state', () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByRole('button', { name: 'Disabled' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('calls onClick handler', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Click' }) as HTMLButtonElement);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('applies small size variant', () => {
    render(<Button size="small">Small</Button>);
    const button = screen.getByRole('button', { name: 'Small' }) as HTMLButtonElement;
    expect(button.className).toContain('button--small');
  });
});

describe('Input', () => {
  it('renders input with label and value', () => {
    const handleChange = vi.fn();
    render(
      <Input id="email" label="Email" value="test@example.com" onChange={handleChange} />
    );
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(input.value).toBe('test@example.com');
  });

  it('calls onChange with event', () => {
    const handleChange = vi.fn();
    render(<Input id="name" label="Name" value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'John' } });
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('applies disabled state', () => {
    render(<Input id="disabled" label="Disabled" value="x" disabled onChange={vi.fn()} />);
    const input = screen.getByLabelText('Disabled') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('shows error message when provided', () => {
    render(<Input id="err" value="" error="Invalid input" onChange={vi.fn()} />);
    const alert = screen.getByRole('alert') as HTMLElement;
    expect(alert.textContent).toContain('Invalid input');
  });
});

describe('Select', () => {
  it('renders select with options', () => {
    const options = [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' },
    ];
    const handleChange = vi.fn();
    render(
      <Select id="sel" label="Select" value="a" options={options} onChange={handleChange} />
    );
    const select = screen.getByLabelText('Select') as HTMLSelectElement;
    expect(select.value).toBe('a');
    expect(screen.getByText('Option A')).toBeTruthy();
    expect(screen.getByText('Option B')).toBeTruthy();
  });

  it('calls onChange with new value', () => {
    const handleChange = vi.fn();
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    render(<Select id="sel" label="Select" value="a" options={options} onChange={handleChange} />);
    const select = screen.getByLabelText('Select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'b' } });
    expect(handleChange).toHaveBeenCalledTimes(1);
  });
});

describe('Checkbox', () => {
  it('renders checkbox with label', () => {
    const handleChange = vi.fn();
    render(<Checkbox id="agree" checked={false} label="I agree" onChange={handleChange} />);
    const checkbox = screen.getByLabelText('I agree') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('calls onChange when checked', () => {
    const handleChange = vi.fn();
    render(<Checkbox id="agree" checked={false} label="Agree" onChange={handleChange} />);
    const checkbox = screen.getByLabelText('Agree') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('applies disabled state', () => {
    render(<Checkbox id="dis" checked={false} label="Disabled" disabled onChange={vi.fn()} />);
    const checkbox = screen.getByLabelText('Disabled') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });
});

describe('Badge', () => {
  it('renders children with variant class', () => {
    render(<Badge variant="success">Active</Badge>);
    const badge = screen.getByText('Active') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('badge--success');
  });

  it('defaults to neutral variant', () => {
    render(<Badge>Neutral</Badge>);
    const badge = screen.getByText('Neutral') as HTMLElement;
    expect(badge.className).toContain('badge--neutral');
  });
});

describe('Card', () => {
  it('renders title, description and children', () => {
    render(
      <Card title="Title" description="Desc">
        <p>Body content</p>
      </Card>
    );
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Desc')).toBeTruthy();
    expect(screen.getByText('Body content')).toBeTruthy();
  });

  it('renders actions when provided', () => {
    render(
      <Card title="T" actions={<button>Save</button>}>
        <p>Body</p>
      </Card>
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('Table', () => {
  it('renders columns and rows', () => {
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
    ];
    const rows = [
      { name: 'Alice', status: 'Active' },
      { name: 'Bob', status: 'Inactive' },
    ];
    render(
      <Table
        columns={columns}
        rows={rows}
        row={(item) => (
          <>
            <td>{item.name}</td>
            <td>{item.status}</td>
          </>
        )}
      />
    );
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});

describe('Modal', () => {
  it('renders when isOpen is true', () => {
    const handleClose = vi.fn();
    render(
      <Modal isOpen title="Title" onClose={handleClose}>
        <p>Content</p>
      </Modal>
    );
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Content')).toBeTruthy();
  });

  it('renders nothing when isOpen is false', () => {
    render(<Modal isOpen={false} title="Title" onClose={vi.fn()} children={<div />} />);
    expect(screen.queryByText('Title')).toBeNull();
  });

  it('calls onClose when close button clicked', () => {
    const handleClose = vi.fn();
    render(
      <Modal isOpen title="Title" onClose={handleClose}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.click(screen.getByLabelText('Close dialog') as HTMLButtonElement);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

describe('Notification', () => {
  it('renders message with variant', () => {
    render(<Notification variant="success">Saved successfully</Notification>);
    const alert = screen.getByRole('alert') as HTMLElement;
    expect(alert.textContent).toContain('Saved successfully');
  });

  it('calls onClose when close button clicked', () => {
    const handleClose = vi.fn();
    render(
      <Notification variant="danger" onClose={handleClose}>
        Error occurred
      </Notification>
    );
    fireEvent.click(screen.getByLabelText('Dismiss notification') as HTMLButtonElement);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

describe('Loading', () => {
  it('renders loading spinner', () => {
    render(<Loading message="Loading..." />);
    expect(screen.getByText('Loading...')).toBeTruthy();
    const status = screen.getByRole('status') as HTMLElement;
    expect(status.getAttribute('aria-busy')).toBe('true');
  });

  it('renders without message', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('renders title and children', () => {
    render(
      <EmptyState title="No items">
        <p>Nothing here yet.</p>
      </EmptyState>
    );
    expect(screen.getByText('No items')).toBeTruthy();
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('renders action when provided', () => {
    render(
      <EmptyState title="Empty">
        <p>Nothing.</p>
        <button>Add item</button>
      </EmptyState>
    );
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('renders title and children', () => {
    render(
      <ErrorState title="Error">
        <p>Something went wrong.</p>
      </ErrorState>
    );
    const alert = screen.getByRole('alert') as HTMLElement;
    expect(alert.textContent).toContain('Error');
    expect(screen.getByText('Something went wrong.')).toBeTruthy();
  });

  it('renders details when provided', () => {
    render(
      <ErrorState title="Error" details="Failed to connect">
        <p>Error occurred.</p>
      </ErrorState>
    );
    expect(screen.getByText('Failed to connect')).toBeTruthy();
  });
});

describe('ConfirmationDialog', () => {
  it('renders title and message when open', () => {
    render(
      <ConfirmationDialog
        isOpen
        title="Delete item"
        message="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Delete item')).toBeTruthy();
    expect(screen.getByText('Are you sure?')).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmationDialog
        isOpen={false}
        title="Title"
        message="Message"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText('Title')).toBeNull();
  });

  it('calls onConfirm when confirm clicked', () => {
    const handleConfirm = vi.fn();
    render(
      <ConfirmationDialog
        isOpen
        title="Title"
        message="Message"
        onConfirm={handleConfirm}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }) as HTMLButtonElement);
    expect(handleConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel clicked', () => {
    const handleCancel = vi.fn();
    render(
      <ConfirmationDialog
        isOpen
        title="Title"
        message="Message"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement);
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Pagination', () => {
  it('renders pagination controls', () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination currentPage={1} totalItems={100} onPageChange={handlePageChange} />
    );
    expect(screen.getByText('Page 1 of 5 (100 items)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();
    const prev = screen.queryByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(prev).toBeTruthy();
    expect(prev.disabled).toBe(true);
  });

  it('calls onPageChange when page clicked', () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination currentPage={1} totalItems={100} onPageChange={handlePageChange} />
    );
    const pageButtons = screen.getAllByRole('button', { name: '2' });
    fireEvent.click(pageButtons[pageButtons.length - 1] as HTMLButtonElement);
    expect(handlePageChange).toHaveBeenCalledWith(2);
  });

  it('disables previous on first page', () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination currentPage={1} totalItems={100} onPageChange={handlePageChange} />
    );
    const prev = screen.queryByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(prev).toBeTruthy();
    expect(prev.disabled).toBe(true);
  });

  it('disables next on last page', () => {
    const handlePageChange = vi.fn();
    render(
      <Pagination currentPage={5} totalItems={100} onPageChange={handlePageChange} />
    );
    const next = screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});
