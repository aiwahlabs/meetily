'use client';

import React from 'react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface MainContentProps {
  children: React.ReactNode;
}

// AIWAH: offsets match the Liro sidebar (rail 4rem, expanded 16rem). Pages own their padding.
const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed } = useSidebar();

  return (
    <main
      className={`flex-1 min-w-0 overflow-hidden bg-background transition-[margin] duration-200 ease-out ${
        isCollapsed ? 'ml-16' : 'ml-64'
      }`}
    >
      <div className="min-w-0 w-full max-w-full overflow-hidden">{children}</div>
    </main>
  );
};

export default MainContent;
