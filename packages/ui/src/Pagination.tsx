/**
 * Pagination — pagination control with previous/next and page links.
 *
 * Renders a <nav> with prev/next buttons and page number links. The current
 * page is highlighted. Total pages are derived from totalItems and pageSize.
 */

import type { ReactElement } from 'react';

export interface PaginationProps {
  readonly currentPage: number;
  readonly totalItems: number;
  readonly pageSize?: number;
  readonly onPageChange: (page: number) => void;
  readonly className?: string;
}

export function Pagination({
  currentPage,
  totalItems,
  pageSize = 20,
  onPageChange,
  className = '',
}: PaginationProps): ReactElement {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  const start = Math.max(1, currentPage - 1);
  const end = Math.min(totalPages, currentPage + 1);

  return (
    <nav className={`pagination ${className}`.trim()} aria-label="Pagination">
      <div className="pagination-controls">
        <button
          type="button"
          className="pagination-button"
          disabled={!hasPrev}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="Previous page"
        >
          ← Previous
        </button>
        {Array.from({ length: end - start + 1 }, (_, i) => start + i).map(
          (page) => (
            <button
              key={page}
              type="button"
              className={`pagination-page ${
                page === currentPage ? 'pagination-page--current' : ''
              }`}
              onClick={() => onPageChange(page)}
              aria-current={page === currentPage ? 'page' : undefined}
            >
              {page}
            </button>
          ),
        )}
        <button
          type="button"
          className="pagination-button"
          disabled={!hasNext}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="Next page"
        >
          Next →
        </button>
      </div>
      <span className="pagination-info">
        Page {currentPage} of {totalPages} ({totalItems} items)
      </span>
    </nav>
  );
}
