import { Fragment } from "react";
import { useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "../auth/AuthContext.tsx";
import { OrganisationPicker } from "./OrganisationPicker.tsx";
import { sectionFor } from "./Rail.tsx";

/**
 * The bar above every screen: the sidebar toggle, where you are, and whose
 * data you are looking at. The account moved to the sidebar's foot.
 *
 * The breadcrumb is plain text, not headings — each screen names itself with
 * its own `h2` (PageHeader), and a second heading with the same name would
 * make "the Agents heading" ambiguous to a screen reader and to tests alike.
 */
export function TopBar() {
  const { session } = useAuth();
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  const deeper = section !== null && pathname !== section.item.to && section.item.to !== "/";

  const crumbs: string[] = section === null ? [] : [section.group, section.item.label];
  if (deeper) crumbs.push("Details");

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList>
          {crumbs.map((crumb, index) => (
            <Fragment key={`${crumb}-${index}`}>
              {index > 0 && <BreadcrumbSeparator className={index === 1 ? "hidden md:block" : undefined} />}
              <BreadcrumbItem className={index === 0 ? "hidden md:block" : undefined}>
                {index === crumbs.length - 1 ? (
                  <BreadcrumbPage>{crumb}</BreadcrumbPage>
                ) : (
                  <span className="text-muted-foreground">{crumb}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {session !== null && <OrganisationPicker />}
    </header>
  );
}
