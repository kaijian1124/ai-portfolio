import Link from "next/link";

export type LogQuery = Record<string, string | string[] | undefined>;
const sizes = [10, 20, 50] as const;

export function logPagination(query: LogQuery, key: string) {
  const size =
    sizes.find((value) => String(value) === query[key + "Size"]) ?? 10;
  const raw = query[key + "Page"];
  const page =
    typeof raw === "string" &&
    /^[1-9]\d{0,6}$/.test(raw) &&
    Number(raw) <= 2000000
      ? Number(raw)
      : 1;
  return { page, size };
}

export function LogPagination({
  query,
  path,
  name,
  label,
  hasNext,
  filter,
}: {
  query: LogQuery;
  path: string;
  name: string;
  label: string;
  hasNext: boolean;
  filter?: { label: string; value: string; options: readonly string[] };
}) {
  const { page, size } = logPagination(query, name);
  const pageKey = name + "Page";
  const sizeKey = name + "Size";
  const filterKey = name + "Filter";
  const preserved = Object.entries(query).flatMap<[string, string]>(
    ([key, value]) =>
      key !== pageKey &&
      key !== sizeKey &&
      key !== filterKey &&
      /^(requests|audit|jobs)(Page|Size|Filter)$/.test(key) &&
      typeof value === "string"
        ? [[key, value]]
        : [],
  );
  function href(target: number) {
    return (
      path +
      "?" +
      new URLSearchParams([
        ...preserved,
        ...(filter?.value ? [[filterKey, filter.value]] : []),
        [pageKey, String(target)],
        [sizeKey, String(size)],
      ])
    );
  }
  return (
    <nav className="ingestion-pagination" aria-label={label + " pagination"}>
      <form
        key={filter?.value + ":" + size}
        action={path}
        method="get"
        className="ingestion-pagination"
        aria-label={label + " filters"}
      >
        {preserved.map(([key, value]) => (
          <input key={key} name={key} value={value} type="hidden" />
        ))}
        {filter && (
          <>
            <label htmlFor={filterKey}>{filter.label}</label>
            <select id={filterKey} name={filterKey} defaultValue={filter.value}>
              <option value="">All</option>
              {filter.options.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor={sizeKey}>Rows per page</label>
        <select id={sizeKey} name={sizeKey} defaultValue={size}>
          {sizes.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit">Apply</button>
      </form>
      {page > 1 && <Link href={href(page - 1)}>Previous page</Link>}
      <span>Page {page}</span>
      {hasNext && <Link href={href(page + 1)}>Next page</Link>}
    </nav>
  );
}

export type LogPage<T> = { rows: T[]; has_next: boolean };
