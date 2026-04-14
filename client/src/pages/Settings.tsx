import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Save } from 'lucide-react';

export default function Settings() {
  const [hostname, setHostname] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // TODO: Add API call to save global settings
      alert('Settings saved');
    } catch (err: any) {
      alert(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Global Settings</h1>
        
        <Card>
          <CardHeader>
            <CardTitle>Hostname Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hostname">Base Hostname</Label>
              <Input
                id="hostname"
                placeholder="convexer.example.com"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                This hostname will be used as the base for instance subdomains. For example, if set to "convexer.example.com", instances will be accessible as "instance-name.convexer.example.com".
              </p>
            </div>

            <Button onClick={handleSave} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
