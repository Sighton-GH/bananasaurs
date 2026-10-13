import { useLocation, useSearchParams } from 'wouter';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { Channels } from './channels.js';
import { AssistantPermissions } from './assistant.js';
import { SpecialisedPermissions } from './specialised.js';

const TABS = [
  { value: 'channels', label: 'Channels' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'specialised', label: 'Specialised' },
];

export function PermissionsPage() {
  const [params] = useSearchParams();
  const [location, navigate] = useLocation();
  const selected = params.get('tab');
  const tab = TABS.find((item) => item.value === selected)?.value ?? 'channels';
  return (
    <>
      <PageHeader
        title="Permissions"
        purpose="Choose what Bananasaurs may do in each channel or category. Read, Write and Archive are separate switches; No access overrides all three."
      />
      <Tabs
        aria-label="Permissions sections"
        value={tab}
        tabs={TABS}
        onValueChange={(value) => {
          const next = new URLSearchParams(params);
          next.set('tab', value);
          navigate(`${location}?${next.toString()}${window.location.hash}`);
        }}
      >
        <TabPanel value="channels">
          <Channels />
        </TabPanel>
        <TabPanel value="assistant">
          <AssistantPermissions />
        </TabPanel>
        <TabPanel value="specialised">
          <SpecialisedPermissions />
        </TabPanel>
      </Tabs>
    </>
  );
}
