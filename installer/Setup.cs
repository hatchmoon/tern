using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Drawing;
using Microsoft.Win32;
using System.Runtime.InteropServices;

public static class Setup {
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)]
  static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,UIntPtr w,string l,uint flags,uint timeout,out UIntPtr result);
  static bool silent=false,noPath=false;
  static string root;
  static Form progress;
  static int waitPid=0;
  static string Hash(Stream stream){using(SHA256 hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  static string HashFile(string path){using(FileStream file=File.OpenRead(path))return Hash(file);}
  static string Child(string parent,string name){string target=Path.GetFullPath(Path.Combine(parent,name));if(!target.StartsWith(parent+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Unsafe archive path.");return target;}
  static void AtomicText(string path,string value){string temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";File.WriteAllText(temp,value,new UTF8Encoding(false));if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);}
  static void UpdatePath(bool add){
    if(noPath)return;
    string bin=Path.Combine(root,"bin"),old=Environment.GetEnvironmentVariable("Path",EnvironmentVariableTarget.User)??"";
    List<string> parts=new List<string>();foreach(string part in old.Split(';'))if(!String.Equals(part.Trim().TrimEnd('\\'),bin.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)&&part.Length>0)parts.Add(part);
    if(add)parts.Insert(0,bin);Environment.SetEnvironmentVariable("Path",String.Join(";",parts.ToArray()),EnvironmentVariableTarget.User);
    UIntPtr result;SendMessageTimeout(new IntPtr(0xffff),0x1a,UIntPtr.Zero,"Environment",2,5000,out result);
  }
  static void Register(){
    if(noPath)return;
    using(RegistryKey key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchMoonTern")){
      key.SetValue("DisplayName","Tern CLI");key.SetValue("DisplayVersion",BuildInfo.Version);key.SetValue("Publisher","HatchMoon");
      key.SetValue("InstallLocation",root);key.SetValue("UninstallString","\""+Path.Combine(root,"Uninstall.exe")+"\" /uninstall /dir \""+root+"\"");
      key.SetValue("NoModify",1);key.SetValue("NoRepair",1);key.SetValue("URLInfoAbout","https://tern.hatchmoon.cv");
    }
  }
  static void ShowProgress(){
    if(silent)return;progress=new Form();progress.Text="Installing Tern";progress.Width=540;progress.Height=170;progress.StartPosition=FormStartPosition.CenterScreen;progress.ControlBox=false;
    Label text=new Label();text.Text="Verifying and installing Tern CLI…\nYour settings and signing keys are preserved.";text.Font=new Font("Segoe UI",11);text.Dock=DockStyle.Fill;text.Padding=new Padding(20);progress.Controls.Add(text);progress.Show();Application.DoEvents();
  }
  static void Install(){
    if(!Environment.Is64BitOperatingSystem)throw new Exception("This installer requires 64-bit Windows.");
    if(Directory.Exists(root)&&Directory.GetFileSystemEntries(root).Length>0&&!File.Exists(Path.Combine(root,".tern-install")))throw new Exception("The destination contains other files. Choose an empty folder.");
    Directory.CreateDirectory(root);File.WriteAllText(Path.Combine(root,".tern-install"),"HatchMoon Tern managed installation\n");
    using(FileStream installLock=new FileStream(Path.Combine(root,".install-lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
      string stage=Child(root,"staging-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(stage);
      try{
        using(Stream payload=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")){
          if(payload==null||Hash(payload)!=BuildInfo.PayloadHash)throw new Exception("Installer payload verification failed.");payload.Position=0;
          using(ZipArchive zip=new ZipArchive(payload,ZipArchiveMode.Read)){
            ZipArchiveEntry manifestEntry=zip.GetEntry("payload-manifest.json");if(manifestEntry==null)throw new Exception("Missing payload manifest.");
            Dictionary<string,string> manifest;
            using(StreamReader reader=new StreamReader(manifestEntry.Open()))manifest=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(reader.ReadToEnd());
            int files=0;
            foreach(ZipArchiveEntry entry in zip.Entries){
              if(entry.FullName.EndsWith("/"))continue;
              if(entry.FullName=="payload-manifest.json")continue;
              string expected;if(!manifest.TryGetValue(entry.FullName,out expected))throw new Exception("Unexpected payload file.");
              string path=Child(stage,entry.FullName.Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(path));
              using(Stream input=entry.Open())using(FileStream output=new FileStream(path,FileMode.CreateNew))input.CopyTo(output);
              if(HashFile(path)!=expected)throw new Exception("Payload checksum failed: "+entry.FullName);files++;if(progress!=null)Application.DoEvents();
            }
            if(files!=manifest.Count)throw new Exception("Incomplete installer payload.");
          }
        }
        ProcessStartInfo check=new ProcessStartInfo(Path.Combine(stage,"node.exe"),"\""+Path.Combine(stage,"cli","tern.mjs")+"\" --version");check.UseShellExecute=false;check.CreateNoWindow=true;check.RedirectStandardOutput=true;
        using(Process child=Process.Start(check)){string version=child.StandardOutput.ReadToEnd().Trim();child.WaitForExit();if(child.ExitCode!=0||version!=BuildInfo.Version)throw new Exception("Installed CLI did not pass its startup check.");}
        string folder=BuildInfo.Version+"-"+BuildInfo.PayloadHash.Substring(0,12),versions=Child(root,"versions");Directory.CreateDirectory(versions);string target=Child(versions,folder);
        // A completed version is immutable. Reinstallations verify it before reuse.
        if(Directory.Exists(target)){
          foreach(string file in Directory.GetFiles(stage,"*",SearchOption.AllDirectories)){
            string relative=file.Substring(stage.Length+1),existing=Child(target,relative);
            if(!File.Exists(existing)||HashFile(existing)!=HashFile(file))throw new Exception("An existing installation is damaged. Remove its version folder, then rerun Setup.");
          }
          Directory.Delete(stage,true);
        }else Directory.Move(stage,target);
        string bin=Child(root,"bin");Directory.CreateDirectory(bin);
        string launcher=Path.Combine(bin,"tern.exe");if(!File.Exists(launcher))File.Copy(Path.Combine(target,"launcher.exe"),launcher);
        string uninstaller=Path.Combine(root,"Uninstall.exe");if(!String.Equals(Assembly.GetExecutingAssembly().Location,uninstaller,StringComparison.OrdinalIgnoreCase))File.Copy(Assembly.GetExecutingAssembly().Location,uninstaller,true);
        string current=Path.Combine(root,"current.txt");if(File.Exists(current)&&File.ReadAllText(current).Trim()!=folder)AtomicText(Path.Combine(root,"previous.txt"),File.ReadAllText(current));
        UpdatePath(true);Register();AtomicText(current,folder+"\n");
      }finally{if(Directory.Exists(stage))Directory.Delete(stage,true);}
    }
  }
  static bool Uninstall(){
    if(!File.Exists(Path.Combine(root,".tern-install")))throw new Exception("This is not a managed Tern installation.");
    string self=Assembly.GetExecutingAssembly().Location;
    if(self.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)){
      string copy=Path.Combine(Path.GetTempPath(),"TernUninstall-"+Guid.NewGuid().ToString("N")+".exe");File.Copy(self,copy);
      Process.Start(new ProcessStartInfo(copy,"/uninstall /wait "+Process.GetCurrentProcess().Id+" /dir \""+root+"\""+(silent?" /silent":"")+(noPath?" /nopath":"")){UseShellExecute=false});return false;
    }
    using(FileStream installLock=new FileStream(Path.Combine(root,".install-lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None)){}
    UpdatePath(false);if(!noPath)Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\HatchMoonTern",false);
    Directory.Delete(root,true);
    return true;
  }
  [STAThread] public static int Main(string[] args){
    Application.EnableVisualStyles();root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Tern");bool uninstall=false;
    try{
      for(int i=0;i<args.Length;i++){if(args[i].Equals("/silent",StringComparison.OrdinalIgnoreCase))silent=true;else if(args[i].Equals("/nopath",StringComparison.OrdinalIgnoreCase))noPath=true;else if(args[i].Equals("/uninstall",StringComparison.OrdinalIgnoreCase))uninstall=true;else if(args[i].Equals("/wait",StringComparison.OrdinalIgnoreCase)&&i+1<args.Length)waitPid=Int32.Parse(args[++i]);else if(args[i].Equals("/dir",StringComparison.OrdinalIgnoreCase)&&i+1<args.Length)root=args[++i];else throw new Exception("Unknown installer argument: "+args[i]);}
      root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
      if(root.Length<5||Path.GetPathRoot(root).TrimEnd('\\')==root)throw new Exception("Choose a dedicated installation folder.");
      if(waitPid>0){try{Process.GetProcessById(waitPid).WaitForExit(30000);}catch(ArgumentException){}}
      if(!silent&&waitPid==0&&MessageBox.Show((uninstall?"Remove Tern CLI from ":"Install Tern CLI "+BuildInfo.Version+" in ")+root+"?\n\n"+(uninstall?"Your user settings and signing keys will be retained.":"No administrator access is needed. Reopen your terminal after installation."),"Tern",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return 2;
      if(uninstall){if(!Uninstall())return 0;}else{ShowProgress();Install();}if(progress!=null)progress.Close();
      if(!silent)MessageBox.Show(uninstall?"Tern was removed. User settings and keys were retained.":"Tern is installed. Open a new terminal and run:\n\ntern login --server https://tern.hatchmoon.cv\n\nThen open your Flutter project and run tern connect.","Tern",MessageBoxButtons.OK,MessageBoxIcon.Information);return 0;
    }catch(Exception error){if(progress!=null)progress.Close();if(!silent)MessageBox.Show(error.Message,"Tern installation failed",MessageBoxButtons.OK,MessageBoxIcon.Error);else{try{File.WriteAllText(Path.Combine(Path.GetTempPath(),"tern-install-error.log"),error.ToString());}catch{}}return 1;}
  }
}
